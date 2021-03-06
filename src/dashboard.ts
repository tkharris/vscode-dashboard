'use strict';
import * as vscode from 'vscode';
import * as path from 'path';
import { Project, GroupOrder, ProjectGroup, ProjectRemoteType, getRemoteType, DashboardInfos } from './models';
import { getProjects, addProject, removeProject, saveProjects, writeTextFile, getProject, addProjectGroup, getProjectsFlat, migrateDataIfNeeded, getProjectAndGroup, updateProject, getProjectsGroup, updateProjectGroup, removeProjectsGroup } from './projectService';
import { getDashboardContent } from './webviewContent';
import { USE_PROJECT_COLOR, PREDEFINED_COLORS, StartupOptions, USER_CANCELED, FixedColorOptions, RelevantExtensions, SSH_REGEX, REMOTE_REGEX, SSH_REMOTE_PREFIX } from './constants';
import { execSync } from 'child_process';
import { lstatSync } from 'fs';

export function activate(context: vscode.ExtensionContext) {
    var instance: vscode.WebviewPanel = null;

    const dashboardInfos: DashboardInfos = {
        relevantExtensionsInstalls: {
            remoteSSH: false,
        },
        get config() { return vscode.workspace.getConfiguration('dashboard') },
    };

    const openCommand = vscode.commands.registerCommand('dashboard.open', () => {
        showDashboard();
    });

    const addProjectCommand = vscode.commands.registerCommand('dashboard.addProject', async (projectGroupId: string = null) => {
        await addProjectPerCommand(projectGroupId);
    });

    const removeProjectCommand = vscode.commands.registerCommand('dashboard.removeProject', async () => {
        await removeProjectPerCommand();
    });

    const editProjectsManuallyCommand = vscode.commands.registerCommand('dashboard.editProjects', async () => {
        await editProjectsManuallyPerCommand();
    });

    context.subscriptions.push(openCommand);
    context.subscriptions.push(addProjectCommand);
    context.subscriptions.push(removeProjectCommand);
    context.subscriptions.push(editProjectsManuallyCommand);

    startUp();

    // ~~~~~~~~~~~~~~~~~~~~~~~~~ Functions ~~~~~~~~~~~~~~~~~~~~~~~~~
    async function startUp() {
        for (let exName in dashboardInfos.relevantExtensionsInstalls) {
            let exId = RelevantExtensions[exName];
            let installed = vscode.extensions.getExtension(exId) !== undefined;
            dashboardInfos.relevantExtensionsInstalls[exName] = installed;
        }

        let migrated = await migrateDataIfNeeded(context);
        if (migrated) {
            vscode.window.showInformationMessage("Migrated Dashboard Projects after changing Settings.");
        }

        showDashboardOnOpenIfNeeded();
    }

    function showDashboardOnOpenIfNeeded() {
        var { openOnStartup } = dashboardInfos.config;

        var open = false;

        switch (openOnStartup) {
            case StartupOptions.always:
                open = true;
                break;
            case StartupOptions.never:
                break;
            case StartupOptions.emptyWorkSpace:
            default:
                let editors = vscode.window.visibleTextEditors;
                // Includes Workaround for temporary code runner file
                let noOpenEditorsOrWorkspaces = !vscode.workspace.name && (
                    editors.length === 0 || editors.length === 1 && editors[0].document.languageId === "code-runner-output"
                );
                open = noOpenEditorsOrWorkspaces;
                break;
        }

        if (open) {
            showDashboard();
        }
    }

    function showDashboard() {
        var columnToShowIn = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : null;
        var projects = getProjects(context);

        if (instance) {
            instance.webview.html = getDashboardContent(context, instance, projects, dashboardInfos);
            instance.reveal(columnToShowIn);
        } else {
            var panel = vscode.window.createWebviewPanel(
                "dashboard",
                "Dashboard",
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    localResourceRoots: [
                        vscode.Uri.file(path.join(context.extensionPath, 'media')),
                    ],
                },
            );
            panel.iconPath = vscode.Uri.file("");

            panel.webview.html = getDashboardContent(context, panel, projects, dashboardInfos);

            // Reset when the current panel is closed
            panel.onDidDispose(() => {
                instance = null;
            }, null, context.subscriptions);

            panel.webview.onDidReceiveMessage(async (e) => {
                let projectId: string, projectGroupId: string;
                switch (e.type) {
                    case 'selected-project':
                        projectId = e.projectId as string;
                        let newWindow = e.newWindow as boolean;
                        let project = getProject(context, projectId);
                        if (project == null) {
                            vscode.window.showWarningMessage("Selected Project not found.");
                            break;
                        }

                        await openProject(project, newWindow);
                        break;
                    case 'add-project':
                        projectGroupId = e.projectGroupId as string;
                        await vscode.commands.executeCommand("dashboard.addProject", projectGroupId);
                        break;
                    case 'reordered-projects':
                        let groupOrders = e.groupOrders as GroupOrder[];
                        await reorderProjectGroups(groupOrders);
                        break;
                    case 'delete-project':
                        projectId = e.projectId as string;
                        await deleteProject(projectId);
                        break;
                    case 'edit-project':
                        projectId = e.projectId as string;
                        await editProject(projectId);
                        break;
                    case 'edit-projects-group':
                        projectGroupId = e.projectGroupId as string;
                        await editProjectsGroup(projectGroupId);
                        break;
                    case 'delete-projects-group':
                        projectGroupId = e.projectGroupId as string;
                        await deleteProjectsGroup(projectGroupId);
                        break;

                }
            });

            instance = panel;
        }
    }

    async function editProjectsGroup(projectGroupId: string) {
        var group = getProjectsGroup(context, projectGroupId);
        if (group == null) {
            return;
        }

        // Name
        var groupName = await vscode.window.showInputBox({
            value: group.groupName || undefined,
            valueSelection: group.groupName ? [0, group.groupName.length] : undefined,
            placeHolder: 'Project Group Name',
            ignoreFocusOut: true,
            validateInput: (val: string) => val ? '' : 'A Group Name must be provided.',
        });

        if (groupName == null) {
            //throw new Error(USER_CANCELED);
            return
        }

        group.groupName = groupName;
        await updateProjectGroup(context, projectGroupId, group);

        showDashboard();
    }

    async function deleteProjectsGroup(projectGroupId: string) {
        var group = getProjectsGroup(context, projectGroupId);
        if (group == null) {
            return;
        }

        let accepted = await vscode.window.showWarningMessage(`Delete ${group.groupName}?`, { modal: true }, 'Delete');
        if (!accepted) {
            return;
        }

        await removeProjectsGroup(context, projectGroupId);
        showDashboard();
    }

    async function openProject(project: Project, openInNewWindow: boolean): Promise<void> {
        // project is parsed from JSON at runtime, so its not an instance of Project
        let remoteType = getRemoteType(project);
        let projectPath = (project.path || '').trim();

        let uri: vscode.Uri;
        switch (remoteType) {
            case ProjectRemoteType.None:
                uri = vscode.Uri.file(projectPath);
                await vscode.commands.executeCommand("vscode.openFolder", uri, openInNewWindow);
                break;
            case ProjectRemoteType.SSH:
                let remotePathMatch = projectPath.replace(SSH_REMOTE_PREFIX, '').match(SSH_REGEX);
                let hasRemoteFolder = remotePathMatch.groups.folder != null;

                if (hasRemoteFolder) {
                    uri = vscode.Uri.parse(projectPath);
                    vscode.commands.executeCommand("vscode.openFolder", uri, openInNewWindow)
                } else {
                    vscode.commands.executeCommand("vscode.newWindow", {
                        remoteAuthority: projectPath.replace("vscode-remote://", ""),
                        reuseWindow: !openInNewWindow,
                    });
                }
                break;
        }
    }

    async function addProjectPerCommand(projectGroupId: string = null) {
        var project: Project, selectedGroupId: string;

        try {
            [project, selectedGroupId] = await queryProjectFields(projectGroupId);
            await addProject(context, project, selectedGroupId);
        } catch (error) {
            if (error.message !== USER_CANCELED) {
                vscode.window.showErrorMessage(`An error occured while adding the project.`);
                throw error; // Rethrow error to make vscode log it
            }

            return;
        }

        showDashboard();
    }

    async function editProject(projectId: string) {
        var [project, group] = getProjectAndGroup(context, projectId);
        if (project == null || group == null) {
            return;
        }

        var editedProject: Project, selectedGroupId: string;
        try {
            [editedProject, selectedGroupId] = await queryProjectFields(group.id, project);
            await updateProject(context, projectId, editedProject);
        } catch (error) {
            if (error.message !== USER_CANCELED) {
                vscode.window.showErrorMessage(`An error occured while updating project ${project.name}.`);
            }

            return;
        }

        showDashboard();
    }

    async function queryProjectFields(projectGroupId: string = null, projectTemplate: Project = null): Promise<[Project, string]> {
        // For editing a project: Ignore Group selection and take it from template
        var selectedGroupId: string, projectPath: string;
        var isEditing = projectTemplate != null && projectGroupId != null;

        if (isEditing) {
            // Editing
            selectedGroupId = projectGroupId;
            projectPath = projectTemplate.path;
        } else {
            // New
            selectedGroupId = await queryProjectGroup(projectGroupId);
            projectPath = await queryProjectPath();
        }

        var defaultProjectName = projectTemplate ? projectTemplate.name : null;
        defaultProjectName = defaultProjectName || getLastPartOfPath(projectPath).replace(/\.code-workspace$/g, '');

        // Name
        var projectName = await vscode.window.showInputBox({
            value: defaultProjectName || undefined,
            valueSelection: defaultProjectName ? [0, defaultProjectName.length] : undefined,
            placeHolder: 'Project Name',
            ignoreFocusOut: true,
            validateInput: (val: string) => val ? '' : 'A Project Name must be provided.',
        });

        if (!projectName) {
            throw new Error(USER_CANCELED);
        }

        // Updating path if needed
        if (isEditing) {
            let updatePathPicks = [
                {
                    id: false,
                    label: "Keep Path",
                },
                {
                    id: true,
                    label: "Edit Path"
                },
            ]
            let updatePath = await vscode.window.showQuickPick(updatePathPicks, {
                placeHolder: "Edit Path?"
            });

            if (updatePath == null) {
                throw new Error(USER_CANCELED);
            }

            if (updatePath.id) {
                projectPath = await queryProjectPath(projectPath);
            }
        }

        // Color
        var color = await queryProjectColor(projectTemplate);

        //Test if Git Repo
        let isGitRepo = isFolderGitRepo(projectPath);

        // Save
        let project = new Project(projectName, projectPath);
        project.color = color;
        project.isGitRepo = isGitRepo;

        return [project, selectedGroupId];
    }

    async function queryProjectGroup(projectGroupId: string): Promise<string> {
        var projectGroups = getProjects(context);

        // Reorder array to set given group to front (to quickly select it).
        let orderedProjectGroups = projectGroups;
        if (projectGroupId != null) {
            let idx = projectGroups.findIndex(g => g.id === projectGroupId);
            if (idx != null) {
                orderedProjectGroups = projectGroups.slice();
                let group = orderedProjectGroups.splice(idx, 1);
                orderedProjectGroups.unshift(...group);
            }
        }

        let defaultGroupSet = false;
        let projectGroupPicks = orderedProjectGroups.map(group => {
            let label = group.groupName;
            if (!label) {
                label = defaultGroupSet ? 'Unnamed Group' : 'Default Group';
                defaultGroupSet = true;
            }

            return {
                id: group.id,
                label,
            }
        });

        projectGroupPicks.push({
            id: "Add",
            label: "Add new Project Group",
        })

        let selectedProjectGroupPick = await vscode.window.showQuickPick(projectGroupPicks, {
            placeHolder: "Project Group"
        });

        if (selectedProjectGroupPick == null) {
            throw new Error(USER_CANCELED);
        }

        projectGroupId = selectedProjectGroupPick.id;
        if (projectGroupId === 'Add') {
            let newGroupName = await vscode.window.showInputBox({
                placeHolder: 'New Project Group Name',
                ignoreFocusOut: true,
                validateInput: (val: string) => val ? '' : 'A Group Name must be provided.',
            });

            if (newGroupName == null) {
                throw new Error(USER_CANCELED);
            }

            projectGroupId = (await addProjectGroup(context, newGroupName)).id;
        }

        return projectGroupId;
    }

    async function queryProjectPath(defaultPath: string = null): Promise<string> {
        let projectTypePicks = [
            { id: 'dir', label: 'Folder Project' },
            { id: 'file', label: 'File or Multi-Root Project' },
            { id: 'ssh', label: `SSH Target ${!dashboardInfos.relevantExtensionsInstalls.remoteSSH ? '(Remote Development extension is not installed)' : ''}` },
        ];

        let selectedProjectTypePick = await vscode.window.showQuickPick(projectTypePicks, {
            placeHolder: "Project Type",
        });

        if (selectedProjectTypePick == null) {
            throw new Error(USER_CANCELED);
        }

        if (defaultPath != null) {
            defaultPath = defaultPath.replace(REMOTE_REGEX, ''); // 'Trim vscode-remote://REMOTE_TYPE+'
        }

        switch (selectedProjectTypePick.id) {
            case 'dir':
                return await getPathFromPicker(true, defaultPath);
            case 'file':
                return await getPathFromPicker(false, defaultPath);
            case 'ssh':
                return await getSSHPath(defaultPath);
            default:
                throw new Error(USER_CANCELED);
        }
    }

    async function getPathFromPicker(folderProject: boolean, defaultPath: string = null): Promise<string> {
        var defaultUri: vscode.Uri = undefined;
        if (defaultPath) {
            defaultUri = vscode.Uri.parse(defaultPath);
        }

        // Path
        let selectedProjectUris = await vscode.window.showOpenDialog({
            defaultUri,
            openLabel: `Select ${folderProject ? 'Folder' : 'File'} as Project`,
            canSelectFolders: folderProject,
            canSelectFiles: !folderProject,
            canSelectMany: false,
        });

        if (selectedProjectUris == null || selectedProjectUris[0] == null) {
            throw new Error(USER_CANCELED);
        }

        return selectedProjectUris[0].fsPath.trim();
    }

    async function getSSHPath(defaultPath: string = null): Promise<string> {
        let remotePath = await vscode.window.showInputBox({
            placeHolder: 'user@target.xyz/home/optional-folder',
            value: defaultPath || undefined,
            ignoreFocusOut: true,
            prompt: "SSH remote, target folder is optional",
            validateInput: (val: string) => SSH_REGEX.test(val) ? '' : 'A valid SSH Target must be proviced',
        });

        if (!remotePath) {
            throw new Error(USER_CANCELED);
        }

        remotePath = `${SSH_REMOTE_PREFIX}${remotePath}`;
        return remotePath.trim();
    }

    async function queryProjectColor(projectTemplate: Project = null): Promise<string> {
        var color: string = null;
        if (!USE_PROJECT_COLOR) {
            return null;
        }

        if (projectTemplate != null) {
            color = projectTemplate.color;
        }

        // Colors are keyed by label, not by value
        // I tried to key them by their value, but the selected QuickPick was always undefined,
        // even when sanitizing the values (to alphanumeric only)
        let colorPicks = PREDEFINED_COLORS.map(c => ({
            id: c.label,
            label: c.label,
        }));
        colorPicks.unshift({ id: FixedColorOptions.random, label: 'Random' });
        colorPicks.push({ id: FixedColorOptions.none, label: 'None' });
        colorPicks.push({ id: FixedColorOptions.custom, label: 'Custom Color' });

        if (projectTemplate && projectTemplate.color) {
            // Get existing color name by value
            let color = PREDEFINED_COLORS.find(c => c.value === projectTemplate.color);
            let existingEntryIdx = !color ? -1 : colorPicks.findIndex(p => p.id === color.label);
            // If color is already in quicklist
            if (existingEntryIdx !== -1) {
                // Push to top
                let entry = colorPicks.splice(existingEntryIdx, 1)[0];
                colorPicks.unshift(entry);
            } else {
                // Insert new
                colorPicks.unshift({
                    id: projectTemplate.color,
                    label: `${projectTemplate.color} (previous value)`,
                });
            }
        }

        let selectedColorPick = await vscode.window.showQuickPick(colorPicks, {
            placeHolder: 'Project Color',
        });

        if (selectedColorPick == null) {
            throw new Error(USER_CANCELED);
        }

        switch (selectedColorPick.id) {
            case FixedColorOptions.custom:
                let customColor = await vscode.window.showInputBox({
                    placeHolder: '#cc3344   crimson   rgb(68, 145, 203)   linear-gradient(to right, gold, darkorange)',
                    ignoreFocusOut: true,
                    prompt: "Any color name, value or gradient.",
                });

                color = (customColor || "").replace(/[;"]/g, "").trim();
                break;
            case FixedColorOptions.none:
                color = null;
                break;
            case FixedColorOptions.random:
                let randomColor = PREDEFINED_COLORS[Math.floor(Math.random() * PREDEFINED_COLORS.length)];
                color = randomColor.value;
                break;
            default:
                // PredefinedColor
                let predefinedColor = PREDEFINED_COLORS.find(c => c.label == selectedColorPick.id);
                if (predefinedColor != null) {
                    color = predefinedColor.value;
                } else {
                    color = selectedColorPick.id;
                }
        }

        return color;
    }

    async function removeProjectPerCommand() {
        var projects = getProjectsFlat(context);
        let projectPicks = projects.map(p => ({ id: p.id, label: p.name }));

        let selectedProjectPick = await vscode.window.showQuickPick(projectPicks);

        if (selectedProjectPick == null)
            return;

        await removeProject(context, selectedProjectPick.id)
        showDashboard();
    }

    async function editProjectsManuallyPerCommand() {
        var projects = getProjects(context);
        const tempFilePath = getProjectsTempFilePath();
        try {
            writeTextFile(tempFilePath, JSON.stringify(projects, null, 4));
        } catch (e) {
            vscode.window.showErrorMessage(`Can not write temporary project file under ${tempFilePath}
            ${e.message ? ': ' + e.message : '.'}`);
            return;
        }

        const tempFileUri = vscode.Uri.file(tempFilePath);

        var editProjectsDocument = await vscode.workspace.openTextDocument(tempFileUri);

        await vscode.window.showTextDocument(editProjectsDocument);

        var subscriptions: vscode.Disposable[] = [];
        var editSubscription = vscode.workspace.onWillSaveTextDocument(async (e) => {
            if (e.document == editProjectsDocument) {
                let updatedProjectGroups;
                try {
                    var text = e.document.getText() || "[]";
                    updatedProjectGroups = JSON.parse(text);
                } catch (ex) {
                    vscode.window.showErrorMessage("Edited Projects File can not be parsed.")
                    return;
                }

                // Validate and Cleanup
                var jsonIsInvalid = false;
                if (Array.isArray(updatedProjectGroups)) {
                    for (let group of updatedProjectGroups) {
                        if (group.name && !group.groupName) {
                            // One of the testers produced a group with any groupName
                            // We could not reproduce that, but this may be a result from updating legacy groups
                            // This should fix that issue
                            group.groupName = group.name;
                            delete group.name;
                        }

                        if (group && group.groupName == null && (group.projects == null || !group.projects.length)) {
                            // Remove empty, unnamed group
                            group._delete = true;
                        } else if (!group || !group.id || group.groupName == undefined || !group.projects || !Array.isArray(group.projects)) {
                            jsonIsInvalid = true;
                            break;
                        } else {
                            for (let project of group.projects) {
                                if (!project || !project.id || !project.name || !project.path) {
                                    jsonIsInvalid = true;
                                    break;
                                }

                                // Remove obsolete properties
                                delete project.imageFileName;
                            }
                        }
                    }
                } else {
                    jsonIsInvalid = true;
                }

                if (jsonIsInvalid) {
                    vscode.window.showErrorMessage("Edited Projects File does not meet the Schema expected by Dashboard.");
                    return;
                }

                updatedProjectGroups = updatedProjectGroups.filter(g => !g._delete);

                await saveProjects(context, updatedProjectGroups);
                showDashboard();

                subscriptions.forEach(s => s.dispose());
                // await deleteFile(tempFilePath); // Deleting file does not make sense, as the file gets immidiately saved again after this listener

                // Select and close our document editor
                vscode.window.showTextDocument(e.document);
                vscode.commands.executeCommand('workbench.action.closeActiveEditor')
            }
        });
        subscriptions.push(editSubscription);

        // onDidCloseTextDocument is not called if a file without any changes is closed
        // If the projects are not edited, but the file is closed, we cannot remove the temp file.
        // --> Use a fixed name for the temp file, so that we have at most 1 zombie file lying around
        // var closeSubscription = vscode.workspace.onDidCloseTextDocument(document => {
        //     if (document == editProjectsDocument) {
        //         subscriptions.forEach(s => s.dispose());
        //         deleteFile(tempFilePath);
        //     }
        // });
        // subscriptions.push(closeSubscription);
    }

    async function reorderProjectGroups(groupOrders: GroupOrder[]) {
        var projectGroups = getProjects(context);

        if (groupOrders == null) {
            vscode.window.showInformationMessage('Invalid Argument passed to Reordering Projects.');
            return;
        }


        // Map projects by id for easier access
        var projectMap = new Map<string, Project>();
        for (let group of projectGroups) {
            if (group.projects == null) {
                continue;
            }

            for (let project of group.projects) {
                projectMap.set(project.id, project);
            }
        }

        // Build new, reordered projects group array
        var reorderedProjectGroups: ProjectGroup[] = [];
        for (let { groupId, projectIds } of groupOrders) {
            let group = projectGroups.find(g => g.id === groupId);
            if (group == null) {
                group = new ProjectGroup("Project Group #" + (reorderedProjectGroups.length + 1));
            }

            group.projects = projectIds.map(pid => projectMap.get(pid)).filter(p => p != null);
            reorderedProjectGroups.push(group);
        }

        await saveProjects(context, reorderedProjectGroups);
        showDashboard();
    }

    async function deleteProject(projectId: string) {
        var project = getProject(context, projectId);
        if (project == null) {
            return;
        }

        let accepted = await vscode.window.showWarningMessage(`Delete ${project.name}?`, { modal: true }, 'Delete');
        if (!accepted) {
            return;
        }

        await removeProject(context, projectId);
        showDashboard();
    }

    function isFolderGitRepo(fPath: string) {
        try {
            fPath = lstatSync(fPath).isDirectory() ? fPath : path.dirname(fPath);
            var test = execSync(`cd ${fPath} && git rev-parse --is-inside-work-tree`, { encoding: 'utf8' });
            return !!test;
        } catch (e) {
            return false;
        }
    }

    function getProjectsTempFilePath(): string {
        var savePath = context.globalStoragePath;
        return `${savePath}/Dashboard Projects.json`;
    }

    function getLastPartOfPath(path: string): string {
        if (!path) {
            return "";
        }
        // get last folder of filename of path/remote
        path = path.replace(REMOTE_REGEX, ''); // Remove remote prefix
        path = path.replace(/^\w+\@/, ''); // Remove Username
        let lastPart = path.replace(/^[\\\/]|[\\\/]$/g, '').replace(/^.*[\\\/]/, '');

        return lastPart;
    }
}

// this method is called when your extension is deactivated
export function deactivate() {
}

