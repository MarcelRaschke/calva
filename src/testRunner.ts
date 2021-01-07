import * as vscode from 'vscode';
import * as _ from 'lodash';
import evaluate from './evaluate';
import * as util from './utilities';
import { disabledPrettyPrinter } from './printer';
import * as outputWindow from './results-output/results-doc';
import { NReplSession } from './nrepl';
import * as namespace from './namespace';

let diagnosticCollection = vscode.languages.createDiagnosticCollection('calva');

function reportTests(results, errorStr, log = true) {
    let diagnostics = {};
    let total_summary: { test, error, ns, var, fail } = { test: 0, error: 0, ns: 0, var: 0, fail: 0 };
    diagnosticCollection.clear();
    if (results.err || results.ex) {
        util.logError({
            type: util.ERROR_TYPE.ERROR,
            reason: "Error " + errorStr + ":" + results.err
        });
    } else {
        for (let result of results) {
            for (const ns in result.results) {
                let resultSet = result.results[ns];
                for (const test in resultSet) {
                    for (const a of resultSet[test]) {
                        for (const prop in a) {
                            if (typeof (a[prop]) === 'string') {
                                a[prop] = a[prop].replace(/\r?\n$/, "");
                            }
                        }
                        const resultMessage = (resultItem) => {
                            let msg = [];
                            if (!_.isEmpty(resultItem.context) && resultItem.context !== "false")
                                msg.push(resultItem.context);
                            if (resultItem.message)
                                msg.push(resultItem.message);
                            return `${msg.length > 0 ? msg.join(": ").replace(/\r?\n$/, "") : ''}`;
                        }
                        if (a.type === "error" && log) {
                            const rMsg = resultMessage(a);
                            outputWindow.append(`; ERROR in ${ns}/${test} (line ${a.line}):`);
                            if (rMsg !== '') {
                                outputWindow.append(`; ${resultMessage(a)}`);
                            }
                            outputWindow.append(`; error: ${a.error} (${a.file})\n; expected:\n${a.expected}`);
                        }
                        if (a.type === "fail") {
                            const rMsg = resultMessage(a);
                            let msg = `failure in test: ${test} context: ${a.context}, expected ${a.expected}, got: ${a.actual}`,
                                err = new vscode.Diagnostic(new vscode.Range(a.line - 1, 0, a.line - 1, 1000), msg, vscode.DiagnosticSeverity.Error);
                            if (!diagnostics[a.file])
                                diagnostics[a.file] = [];
                            diagnostics[a.file].push(err);
                            if (log) {
                                outputWindow.append(`; FAIL in ${ns}/${test} (${a.file}:${a.line}):`);
                                if (rMsg !== '') {
                                    outputWindow.append(`; ${resultMessage(a)}`);
                                }
                                outputWindow.append(`; expected:\n${a.expected}\n; actual:\n${a.actual}`);
                            }
                        }
                    }
                }
            }
            if (result.summary !== null) {
                _.each(result.summary, (v, k) => {
                    total_summary[k] = result.summary[k] + (total_summary[k] !== undefined ? total_summary[k] : 0);
                });
            }
        }

        if (total_summary !== null) {
            let hasProblems = total_summary.error + total_summary.fail > 0;
            if (log) {
                outputWindow.append("; " + (total_summary.test > 0 ?
                    total_summary.test + " tests finished, " +
                    (!hasProblems ? "all passing 👍" :
                        "problems found. 😭" +
                        " errors: " + total_summary.error + ", failures: " + total_summary.fail) : "No tests found. 😱") +
                    ", ns: " + total_summary.ns + ", vars: " + total_summary.var);
            }

            if (total_summary.test > 0) {
                if (hasProblems) {
                    _.each(diagnostics, (errors, fileName) => {
                        if (fileName.startsWith('/'))
                            diagnosticCollection.set(vscode.Uri.file(fileName), errors);
                        else {
                            // Sometimes we don't get the full path for some reason. (This is a very inexact
                            // way of dealing with that. Maybe check for the right `ns`in the file?)
                            vscode.workspace.findFiles('**/' + fileName, undefined).then((uri) => {
                                diagnosticCollection.set(uri[0], errors);
                            });
                        }
                    });
                }
            }
        }
    }
}

// FIXME: use cljs session where necessary
async function runAllTests(document = {}) {
    const session = namespace.getSession(util.getFileType(document));
    outputWindow.append("; Running all project tests…");
    reportTests([await session.testAll()], "Running all tests");
    namespace.updateREPLSessionType();
    outputWindow.appendPrompt();
}

function runAllTestsCommand() {
    if (!util.getConnectedState()) {
        vscode.window.showInformationMessage('You must connect to a REPL server to run this command.')
        return;
    }
    runAllTests().catch(() => { });
}

async function considerTestNS(ns: string, session: NReplSession, nss: string[]): Promise<string[]> {
    if (!ns.endsWith('-test')) {
        const testNS = ns + '-test';
        const nsPath = await session.nsPath(testNS);
        const testFilePath = nsPath.path;
        if (testFilePath && testFilePath !== "") {
            const filePath = vscode.Uri.parse(testFilePath).path;
            let loadForms = `(load-file "${filePath}")`;
            await session.eval(loadForms, testNS).value;
        }
        nss.push(testNS);
        return nss;
    }
    return nss;
}

async function runNamespaceTests(document = {}) {
    const doc = util.getDocument(document);
    if (outputWindow.isResultsDoc(doc)) {
        return;
    }
    if (!util.getConnectedState()) {
        vscode.window.showInformationMessage('You must connect to a REPL server to run this command.')
        return;
    }
    const session = namespace.getSession(util.getFileType(document));
    const ns = namespace.getNamespace(doc);
    let nss = [ns];
    await evaluate.loadFile({}, disabledPrettyPrinter);
    outputWindow.append(`; Running tests for ${ns}...`);
    nss = await considerTestNS(ns, session, nss);
    const resultPromises = [session.testNs(nss[0])];
    if (nss.length > 1) {
        resultPromises.push(session.testNs(nss[1]));
    }
    const results = await Promise.all(resultPromises);
    reportTests(results, "Running tests");
    outputWindow.setSession(session, ns);
    namespace.updateREPLSessionType();
    outputWindow.appendPrompt();
}

async function runTestUnderCursor() {
    const doc = util.getDocument({});
    const session = namespace.getSession(util.getFileType(doc));
    const ns = namespace.getNamespace(doc);
    const test = util.getTestUnderCursor();

    if (test) {
        await evaluate.loadFile(doc, disabledPrettyPrinter);
        outputWindow.append(`; Running test: ${test}…`);
        const results = [await session.test(ns, test)];
        reportTests(results, `Running test: ${test}`);
    } else {
        outputWindow.append('; No test found at cursor');
    }
    outputWindow.appendPrompt();
}

function runTestUnderCursorCommand() {
    if (!util.getConnectedState()) {
        vscode.window.showInformationMessage('You must connect to a REPL server to run this command.')
        return;
    }
    runTestUnderCursor().catch(() => { });
}

function runNamespaceTestsCommand() {
    if (!util.getConnectedState()) {
        vscode.window.showInformationMessage('You must connect to a REPL server to run this command.')
        return;
    }
    runNamespaceTests();
}

async function rerunTests(document = {}) {
    let session = namespace.getSession(util.getFileType(document))
    await evaluate.loadFile({}, disabledPrettyPrinter);
    outputWindow.append("; Running previously failed tests…");
    reportTests([await session.retest()], "Retesting");
    outputWindow.appendPrompt();
}

function rerunTestsCommand() {
    if (!util.getConnectedState()) {
        vscode.window.showInformationMessage('You must connect to a REPL server to run this command.')
        return;
    }
    rerunTests();
}

export default {
    runNamespaceTests,
    runNamespaceTestsCommand,
    runAllTestsCommand,
    rerunTestsCommand,
    runTestUnderCursorCommand
};
