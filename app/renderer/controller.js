const electron = require("electron");
const ipc = electron.ipcRenderer;
const fs = require('fs');

const path = require("path");
const $ = window.jQuery = require('./jquery-2.2.3.min.js');

// Debug
const loadTestInk = false;
//remote.getCurrentWindow().webContents.openDevTools();

// Helpers in global objects and namespace

require("./util.js");
require("./split.js");

// Set up context menu
require("./contextmenu.js");

const EditorView = require("./editorView.js").EditorView;
const PlayerView = require("./playerView.js").PlayerView;
const ToolbarView = require("./toolbarView.js").ToolbarView;
const NavView = require("./navView.js").NavView;
const ExpressionWatchView = require("./expressionWatchView").ExpressionWatchView;
const LiveCompiler = require("./liveCompiler.js").LiveCompiler;
const InkProject = require("./inkProject.js").InkProject;
const NavHistory = require("./navHistory.js").NavHistory;
const GotoAnything = require("./goto.js").GotoAnything;
const i18n = require("./i18n.js");

InkProject.setEvents({
    "newProject": (project) => {
        EditorView.focus();
        LiveCompiler.setProject(project);
        var filename = project.activeInkFile.filename();
        ToolbarView.setTitle(filename);
        NavView.setMainInkFilename(filename);
        NavHistory.reset();
        NavHistory.addStep();
    },
    "didSave": () => {
        var activeInk = InkProject.currentProject.activeInkFile;
        ToolbarView.setTitle(activeInk.filename());
        NavView.setMainInkFilename(InkProject.currentProject.mainInk.filename());
        NavView.highlightRelativePath(activeInk.relativePath());
    },
    "didSwitchToInkFile": (inkFile) => {
        var filename = inkFile.filename();
        ToolbarView.setTitle(filename);
        NavView.highlightRelativePath(inkFile.relativePath());
        NavView.setKnots(inkFile);
        var fileIssues = LiveCompiler.getIssuesForFilename(inkFile.relativePath());
        setImmediate(() => EditorView.setErrors(fileIssues));
        NavView.updateCurrentKnot(inkFile, EditorView.getCurrentCursorPos());
        NavHistory.addStep();
    }
});

// Wait for DOM to be ready before kicking most stuff off
// (some of the views get confused otherwise)
$(document).ready(() => {
    if( InkProject.currentProject == null ) {
        InkProject.startNew();
        // Debug
        if( loadTestInk ) {
            var testInk = require("fs").readFileSync(path.join(__dirname, "test.ink"), "utf8");
            InkProject.currentProject.mainInk.setValue(testInk);
        }
        NavView.setKnots(InkProject.currentProject.mainInk);
    }
});

function gotoIssue(issue) {
    InkProject.currentProject.showInkFile(issue.filename);
    EditorView.gotoLine(issue.lineNumber);
    NavHistory.addStep();
}

NavHistory.setEvents({
    goto: (location) => {
        InkProject.currentProject.showInkFile(location.filePath);
        EditorView.gotoLine(location.position.row+1);
    }
})


LiveCompiler.setEvents({
    resetting: (sessionId) => {
        
    },
    compileComplete: (sessionId) => {
        PlayerView.prepareForNewPlaythrough(sessionId);
        EditorView.clearErrors();
        ToolbarView.clearIssueSummary();
    },
    selectIssue: gotoIssue,
    textAdded: (text) => {
        PlayerView.addTextSection(text);
    },
    tagsAdded: (tags) => {
        PlayerView.addTags(tags);
    },
    choiceAdded: (choice, isLatestTurn) => {
        if( isLatestTurn ) {
            PlayerView.addChoice(choice, () => {
                LiveCompiler.choose(choice)
            });
        }
    },
    errorsAdded: (errors) => {
        for(var i=0; i<errors.length; i++) {
            var error = errors[i];
            if( error.filename == InkProject.currentProject.activeInkFile.relativePath() )
                EditorView.addError(error);

            if( error.type == "RUNTIME ERROR" || error.type == "RUNTIME WARNING" )
                PlayerView.addLineError(error, () => gotoIssue(error));
        }

        ToolbarView.updateIssueSummary(errors);
    },
    playerPrompt: (replaying, doneCallback) => {

        var expressionIdx = 0;
        var tryEvaluateNextExpression = () => {

            // Finished evaluating expressions? End of this turn.
            if( expressionIdx >= ExpressionWatchView.numberOfExpressions() ) {
                if( replaying ) {
                    PlayerView.addHorizontalDivider();
                } else {
                    PlayerView.contentReady();
                }
                doneCallback();
                return;
            }

            // Try to evaluate this expression
            var exprText = ExpressionWatchView.getExpression(expressionIdx);
            LiveCompiler.evaluateExpression(exprText, (result, error) => {
                PlayerView.addEvaluationResult(result, error);
                expressionIdx++;
                tryEvaluateNextExpression();
            });
        };

        tryEvaluateNextExpression();
    },
    replayComplete: (sessionId) => {
        PlayerView.showSessionView(sessionId);
    },
    storyCompleted: () => {
        PlayerView.addTerminatingMessage(i18n._("End of story"), "end");
    },
    exitDueToError: () => {
        // No need to do anything - errors themselves being displayed are enough
    },
    unexpectedError: (error) => {
        if( error.indexOf("Unhandled Exception") != -1 ) {
            PlayerView.addTerminatingMessage(i18n._("Sorry, the ink compiler crashed ☹"), "error");
            PlayerView.addTerminatingMessage(i18n._("Here is some diagnostic information:"), "error");

            // Make it a bit less verbose and concentrate on the useful stuff
            // [0x000ea] in /Users/blah/blah/blah/blah/ink/ParsedHierarchy/FlowBase.cs:377
            // After replacement:
            // in FlowBase.cs line 377
            error = error.replace(/\[\w+\] in (?:[\w/]+?)(\w+\.cs):(\d+)/g, "in $1 line $2");

            PlayerView.addLongMessage(error, "diagnostic");
        } else {
            PlayerView.addTerminatingMessage(i18n._("Ink compiler had an unexpected error ☹"), "error");
            PlayerView.addLongMessage(error, "error");
        }
    },
    compilerBusyChanged: (busy) => {
        ToolbarView.setBusySpinnerVisible(busy);
    }
});

const loadFont = (fontPath, titleEl, img, main=Date.now()) => {
    const realPath = fontPath.split("\\").join("/")
    const fontName = `font-${main}`
    const font = new FontFace(fontName, `url(file://${realPath})`)
    font.load().then(loadedFace => {
        document.fonts.add(loadedFace)
        titleEl.style.fontFamily = fontName
        img.style.display = "block"
    })
}

ipc.on("project-stats", (event, visible) => {
    LiveCompiler.getStats((statsObj) => {

        let messageLines = [];
        messageLines.push(i18n._("Project statistics:"));
        messageLines.push("");
        
        messageLines.push(`${i18n._("Words")}: ${statsObj["words"].toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`);
        messageLines.push(`${i18n._("Bytes")}: ${(statsObj["words"]*2).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`);
        messageLines.push("");

        messageLines.push(`${i18n._("Knots")}: ${statsObj["knots"].toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`);
        messageLines.push(`${i18n._("Stitches")}: ${statsObj["stitches"].toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`);
        messageLines.push(`${i18n._("Functions")}: ${statsObj["functions"].toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`);
        messageLines.push("");
 
        messageLines.push(`${i18n._("Choices")}: ${statsObj["choices"].toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`);
        messageLines.push(`${i18n._("Gathers")}: ${statsObj["gathers"].toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`);
        messageLines.push(`${i18n._("Diverts")}: ${statsObj["diverts"].toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`);
        messageLines.push("");

        // messageLines.push(i18n._("Notes: Words should be accurate. Knots include functions. Gathers and diverts may include some implicitly added ones by the compiler, for example in weave. Diverts include END and DONE."));

        // alert(messageLines.join("\n"));
        var modal = document.getElementById("myModal");
        const modalContent = document.getElementsByClassName("modal-content")[0]

        const projectPath = InkProject.currentProject.activeInkFile.projectDir
        const fileSrc = `${projectPath}\\title.png`
        const titlePath = `${projectPath}\\title.txt`
        const fontPath = `${projectPath}\\font.ttf`
        const fontBodyPath = `${projectPath}\\body.ttf`

        const exitsFile = fs.existsSync(fileSrc)
        const titleText = !fs.existsSync(titlePath) ? [fs.writeFileSync(titlePath, ''), ''][1] : fs.readFileSync(titlePath, 'utf8')

        modalContent.innerHTML = `<div class="statistics-modal-content">
            <div class="statistics-left">
                ${messageLines.map(x => `<p>${x}</p>`).join("")}
            </div>
            <div class="statistics-right">
                <h2 id="statistics-title" style="margin: 0px; padding: 0">${titleText}</h2>
                <img id="main-img" src="${fileSrc}?${Date.now()}" style="display: ${exitsFile ? 'block' : 'none'}"/>
                <input id="main-img-input" type="file"/>
                <input id="main-title-input" type="text"/>
                <input id="main-font-input" type="file"/>
                <input id="body-font-input" type="file"/>
            </div>
        </div>
        <p>Notes: Words should be accurate. Knots include functions. Gathers and diverts may include some implicitly added ones by the compiler, for example in weave. Diverts include END and DONE.</p>
        `

        modal.style.display = "block";
        const div = document.querySelector(".ace_layer.ace_gutter-layer.ace_folding-enabled")
        div.style.display = "none"

        window.onclick = function(event) {
            if (event.target == modal) {
                modal.style.display = "none";
                div.style.display = undefined;
            }
        }

        const imgInput = document.getElementById("main-img-input")
        const img = document.getElementById("main-img")
        const titleEl = document.getElementById("statistics-title")
        const titleInputeEl = document.getElementById("main-title-input")
        const fontInputeEl = document.getElementById("main-font-input")
        const bodyInputeEl = document.getElementById("body-font-input")

        titleInputeEl.value = titleText

        loadFont(fontPath, titleEl, img)

        titleInputeEl.oninput = ev => {
            fs.writeFile(titlePath, ev.target.value, err => {
                if(err) console.error(err)
            })
            titleEl.innerHTML = ev.target.value
        }

        imgInput.onchange = ev => {
            const file = ev.target.files[0]
            const filePath = file.path
            fs.copyFile(filePath, fileSrc, err => {
                if(err) return console.error(err)
                img.src = `file://${fileSrc}?${Date.now()}`
                img.style.display = "block"
            })
        }

        fontInputeEl.onchange = ev => {
            const file = ev.target.files[0]
            const filePath = file.path
            fs.copyFile(filePath, fontPath, err => {
                if(err) return console.error(err)
                loadFont(fontPath, titleEl, img)
            })
        }

        bodyInputeEl.onchange = ev => {
            const file = ev.target.files[0]
            const filePath = file.path
            fs.copyFile(filePath, fontBodyPath, err => {
                if(err) return console.error(err)
                console.log(fontBodyPath)
                loadFont(fontBodyPath, { style: {} }, img, 'body')
            })
        }

    });
});

ipc.on("keyboard-shortcuts", (event, visible) => {
    let messageLines = [];
    messageLines.push(i18n._("Useful Keyboard Shortcuts"));
    messageLines.push("");
    messageLines.push(`${i18n._("Find and Replace")}: Ctrl+H ${i18n._("or")} Cmd+H`);
    messageLines.push("");
    messageLines.push(`${i18n._("Find")}: Ctrl+F ${i18n._("or")} Cmd+F`);
    messageLines.push("");
    messageLines.push(`${i18n._("Go to Anything")}: Ctrl+P ${i18n._("or")} Cmd+P`);
    messageLines.push("");
    messageLines.push(`${i18n._("Toggle Comment")}: Ctrl+/ ${i18n._("or")} Cmd+/`);
    messageLines.push("");
    messageLines.push(`${i18n._("Add Multicursor Above")}: Ctrl+Alt+Up ${i18n._("or")} Ctrl+Option+Up`);
    messageLines.push("");
    messageLines.push(`${i18n._("Add Multicursor Below")}: Ctrl+Alt+Down ${i18n._("or")} Ctrl+Option+Down`);
    messageLines.push("");
    messageLines.push(`${i18n._("Temporarily Fold/Unfold Selection")}: Alt+L ${i18n._("or")} Ctrl+Option+Down`);
    messageLines.push("");
    alert(messageLines.join("\n"));
});


EditorView.setEvents({
    "change": () => {
        LiveCompiler.setEdited();
        NavView.setKnots(InkProject.currentProject.activeInkFile);
    },
    "jumpToSymbol": (symbolName, contextPos) => {
        var foundSymbol = InkProject.currentProject.findSymbol(symbolName, contextPos);
        if( foundSymbol ) {
            InkProject.currentProject.showInkFile(foundSymbol.inkFile);
            EditorView.gotoLine(foundSymbol.row+1, foundSymbol.column);
            NavHistory.addStep();
        }
    },
    "jumpToInclude": (includePath) => {
        InkProject.currentProject.showInkFile(includePath);
        NavHistory.addStep();
    },
    "navigate": () => NavHistory.addStep(),
    "changedLine": (pos) =>{
        if (InkProject.currentProject && InkProject.currentProject.activeInkFile){
            NavView.updateCurrentKnot(InkProject.currentProject.activeInkFile, pos);
    }
}
});

PlayerView.setEvents({
    "jumpToSource": (outputTextOffset) => {
        LiveCompiler.getLocationInSource(outputTextOffset, (result) => {
            if( result && result.filename && result.lineNumber ) {
                InkProject.currentProject.showInkFile(result.filename);
                EditorView.gotoLine(result.lineNumber);
            }
        });
    }
});

ExpressionWatchView.setEvents({
    "change": () => {
        LiveCompiler.setEdited();
        $("#player .scrollContainer").css("top", ExpressionWatchView.totalHeight()+"px");
    }
});

ToolbarView.setEvents({
    toggleSidebar: (id, buttonId) => { NavView.toggle(id, buttonId); },
    navigateBack: () => NavHistory.back(),
    navigateForward: () => NavHistory.forward(),
    selectIssue: gotoIssue,
    stepBack: () => {
        PlayerView.previewStepBack();
        LiveCompiler.stepBack();
    },
    rewind:   () => { LiveCompiler.rewind(); }
});

NavView.setEvents({
    clickFileId: (fileId) => {
        var inkFile = InkProject.currentProject.inkFileWithId(fileId);
        InkProject.currentProject.showInkFile(inkFile);
        NavHistory.addStep();
    },
    addInclude: (filename, addToMainInk) => {

        // Force filename to have .ink on the end if it hasn't been done manually by user
        // (Is there ever a scenario where this isn't wanted?)
        // Note that if they write my_file.txt then it will turn into my_file.txt.ink
        if( path.extname(filename) != ".ink" ) filename += ".ink";

        var newInkFile = InkProject.currentProject.addNewInclude(filename, addToMainInk);
        if( newInkFile ) {
            InkProject.currentProject.showInkFile(newInkFile);
            NavHistory.addStep();
            return true;
        }
        return false;
    },
    jumpToRow: (row) => {
        EditorView.gotoLine(row+1);
    }
});

GotoAnything.setEvents({
    gotoFile: (file, row) => {
        InkProject.currentProject.showInkFile(file);
        if( typeof row !== 'undefined' )
            EditorView.gotoLine(row+1);
        NavHistory.addStep();
    },
    lookupRuntimePath: (path, resultHandler) => {
        LiveCompiler.getRuntimePathInSource(path, resultHandler);
    }
});

ipc.on("set-tags-visible", (event, visible) => {
    if( visible )
        $("#main").removeClass("hideTags");
    else
        $("#main").addClass("hideTags");
});



function updateTheme(event, newTheme) {
    let themes = ["dark", "contrast", "focus"];
    themes = themes.filter(e => e !== newTheme);
    if (newTheme && newTheme.toLowerCase() !== 'main')
    {
        $(".window").addClass(newTheme);
    }
    for (const theme of themes) {
        $(".window").removeClass(theme);
    }
	LiveCompiler.setEdited();
}

updateTheme(null, window.localStorage.getItem("theme"));
ipc.on("change-theme", (event, newTheme) => {
		updateTheme(event, newTheme);
    window.localStorage.setItem("theme", newTheme);
});



ipc.on("zoom", (event, amount) => {

    // Search manually for element by ID
    // (jQuery wrapping mutates attributes!)
    let editorEl = document.getElementById("editor");
    let playerEl = document.getElementById("player");

    let currentSize = editorEl.style.fontSize;
    
    if(amount > 2) {
        editorEl.style.fontSize = 12 * amount / 100 + "px";
        playerEl.style.fontSize = 12 * amount / 100 + "px";
    } else {

        if(currentSize == "") {

            if(amount > 0) {
                currentSize = "14";
            } else {
                currentSize = "10";
            }

        } else {

            currentSize = currentSize.substring(0, currentSize.length - 2);
            currentSize = parseInt(currentSize);
            currentSize += amount;
        }
        
        editorEl.style.fontSize = currentSize + "px";
        playerEl.style.fontSize = currentSize + "px";
    }

});

ipc.on("insertSnippet", (event, snippetContent) => {
    EditorView.insert(snippetContent);
});
