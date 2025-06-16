// Obsidian GitHub SyncMate Plugin
// Version: 1.0.0
// Author: cybawizz (Andrew R.S.)
// License: MIT
//
// Description: This robust Obsidian.md plugin provides automated and manual synchronization
//              of your Markdown notes with a GitHub repository, offering essential version
//              control and backup capabilities. It is designed to enhance your Obsidian
//              workflow by integrating seamlessly with GitHub's powerful features.
//
// Key Features:
// - Automated Synchronization: Synchronizes your Obsidian vault with a specified GitHub
//   repository at configurable intervals, ensuring your notes are always backed up.
// - Real-time & Sync-on-Save (Currently Disabled by Default): Future-proofed functionality
//   to support granular synchronization immediately upon file modification or saving,
//   designed for enhanced responsiveness.
// - Comprehensive Conflict Resolution: Offers flexible strategies ('Ask', 'Keep Local',
//   'Prefer GitHub', and 'Attempt Auto-Merge') to intelligently manage content conflicts
//   when changes occur simultaneously in both local and remote repositories.
// - Force Operations: Provides dedicated commands for forcefully pulling all remote changes
//   (overwriting local versions) or forcefully pushing all local changes (overwriting
//   remote history), useful for repository initialization or critical state management.
// - GitHub File History Viewer: Allows users to view the complete commit history for
//   individual Markdown files directly within Obsidian. This includes the ability to
//   inspect the content of any past version and restore it to the current vault state.
// - GitHub Folder History Viewer: Extends version control visibility to entire folders.
//   Users can browse the commit history affecting any specific folder, with detailed insights
//   into changed files within each commit, and the option to view or restore individual
//   files from those historical folder commits.
// - Context Menu Integration: Enhances user accessibility by integrating "Show GitHub
//   File History" and "Show GitHub Folder History" options directly into the Obsidian
//   file explorer's right-click context menu.
// - Status Bar Indicator: Provides real-time synchronization status updates and quick
//   feedback directly within the Obsidian status bar.
// - Configurable Sync Path: Users can define a specific subfolder within their GitHub
//   repository to synchronize, or choose to sync the entire repository root.
// - Notification Control: Offers adjustable verbosity for sync notifications, allowing
//   users to choose between 'Quiet', 'Standard', and 'Verbose' alerts.
// - Mobile Optimizations: Automatically adjusts synchronization intervals for better
//   performance and resource management on mobile devices.
// - Secure Token Handling: Your GitHub Personal Access Token (PAT) is managed securely
//   within Obsidian's plugin storage.

import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, Vault, requestUrl, RequestUrlParam, debounce, MarkdownRenderer, MenuItem, TAbstractFile, Menu } from 'obsidian';

// Defines synchronization types for clarity in function calls and logging.
type SyncType = 'Manual Sync' | 'Auto Sync' | 'Real-time sync' | 'Startup Sync' | 'Save on Close Sync';

// Defines the structure for plugin settings, persisted across sessions.
interface GitHubSyncSettings {
    githubToken: string;
    repoOwner: string;
    repoName: string;
    branch: string;
    syncPath: string; // Stores the subfolder path within the GitHub repository (e.g., "notes" or "" for root).
    autoSync: boolean;
    syncInterval: number;
    conflictResolution: 'local' | 'remote' | 'merge' | 'ask';
    realtimeSync: boolean;
    syncOnSave: boolean;
    lastSyncTime: number;
    notificationVerbosity: 'quiet' | 'standard' | 'verbose';
}

// Default settings applied when the plugin is first loaded or settings are reset.
const DEFAULT_SETTINGS: GitHubSyncSettings = {
    githubToken: '',
    repoOwner: '',
    repoName: '', // Repository name, to be filled by the user.
    branch: 'main',
    syncPath: '', // Default to empty string for repository root.
    autoSync: true, // Automatic synchronization enabled by default.
    syncInterval: 300000, // Default sync interval: 5 minutes (in milliseconds).
    conflictResolution: 'ask', // User is prompted for conflict resolution by default.
    realtimeSync: false, // Real-time sync is deliberately disabled by default.
    syncOnSave: false,   // Sync-on-save is deliberately disabled by default.
    lastSyncTime: 0,
    notificationVerbosity: 'standard', // Standard notification verbosity.
}

// Defines metadata structure for tracking individual files and their GitHub state.
interface FileMetadata {
    path: string;
    githubBlobSha: string; // The SHA-1 hash of the file's content on GitHub.
    lastModified: number; // The last modification timestamp of the local file (mtime).
    localChecksum: string; // SHA-256 checksum of the local file's content.
    remoteContentChecksum: string; // SHA-256 checksum of the content corresponding to githubBlobSha.
    conflicted: boolean; // Flag indicating if the file is currently in a conflict state.
}

// Defines the overall plugin data structure for persistence.
interface PluginData {
    settings: GitHubSyncSettings;
    fileMetadata: Record<string, FileMetadata>; // Stored as a plain object for data persistence.
    pendingDeletions: Record<string, string>; // Maps file paths to their GitHub Blob SHAs for remote deletion.
    remoteChangesPendingForActiveFiles: string[]; // List of file paths with pending remote changes that could not be pulled due to being actively edited.
}

// Defines the live synchronization state of the plugin.
interface SyncState {
    inProgress: boolean; // True if a sync operation is currently running.
    lastSync: number; // Timestamp of the last successful synchronization.
    pendingFiles: Set<string>; // Files modified locally that are awaiting push to GitHub.
    fileMetadata: Map<string, FileMetadata>; // Live map for efficient access to file metadata.
    pendingDeletions: Map<string, string>; // Maps file path to its last known GitHub Blob SHA for remote deletion.
    recentlyPushedFiles: Map<string, number>; // Maps file paths to timestamps of their last successful push.
    recentlyDeletedFromRemote: Map<string, number>; // Maps file paths to timestamps of successful remote deletions.
    lastActiveFile: TFile | null; // Tracks the last active file in Obsidian workspace.
    remoteChangesPendingForActiveFiles: Set<string>; // Files with remote changes that were deferred due to active editing.
}

// Defines grace periods in milliseconds to avoid immediate re-syncs for recently pushed or deleted files.
const RECENTLY_PUSHED_GRACE_PERIOD_MS = 90 * 1000; // 90 seconds.
const RECENTLY_DELETED_GRACE_PERIOD_MS = 120 * 1000; // 120 seconds (2 minutes).

// Modal for resolving content conflicts between local and remote versions of a file.
class ConflictResolutionModal extends Modal {
    private resolve: (resolution: 'local' | 'remote' | 'merge') => void; // Callback to resolve the promise with user's choice.
    private fileName: string;
    private localContent: string;
    private remoteContent: string;

    constructor(app: App, fileName: string, localContent: string, remoteContent: string) {
        super(app);
        this.fileName = fileName;
        this.localContent = localContent;
        this.remoteContent = remoteContent;
    }

    // Called when the modal is opened. Configures its content and styling.
    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: `Conflict in: ${this.fileName}` });

        contentEl.createEl('p', { text: 'The file has been modified both locally and remotely. How would you like to resolve this conflict?' });

        // Container for side-by-side display of local and remote content.
        const contentDisplayContainer = contentEl.createDiv({ cls: 'conflict-content-display' });
        contentDisplayContainer.style.display = 'flex';
        contentDisplayContainer.style.gap = '15px';
        contentDisplayContainer.style.marginTop = '20px';
        contentDisplayContainer.style.width = '100%';

        // Local Version Column
        const localColumn = contentDisplayContainer.createDiv({ cls: 'local-column' });
        localColumn.style.flex = '1';
        localColumn.style.display = 'flex';
        localColumn.style.flexDirection = 'column';
        localColumn.createEl('h3', { text: 'Your Local Version', cls: 'text-lg font-semibold' });
        const localTextarea = localColumn.createEl('textarea', { cls: 'w-full h-64 border rounded p-2 text-sm font-mono' });
        localTextarea.value = this.localContent;
        localTextarea.readOnly = true;
        localTextarea.style.minHeight = '150px';
        localTextarea.style.maxHeight = '300px';
        localTextarea.style.overflow = 'auto';
        localTextarea.style.resize = 'vertical';
        localTextarea.style.fontFamily = 'monospace';

        // Remote Version Column
        const remoteColumn = contentDisplayContainer.createDiv({ cls: 'remote-column' });
        remoteColumn.style.flex = '1';
        remoteColumn.style.display = 'flex';
        remoteColumn.style.flexDirection = 'column';
        remoteColumn.createEl('h3', { text: 'GitHub Version', cls: 'text-lg font-semibold' });
        const remoteTextarea = remoteColumn.createEl('textarea', { cls: 'w-full h-64 border rounded p-2 text-sm font-mono' });
        remoteTextarea.value = this.remoteContent;
        remoteTextarea.readOnly = true;
        remoteTextarea.style.minHeight = '150px';
        remoteTextarea.style.maxHeight = '300px';
        remoteTextarea.style.overflow = 'auto';
        remoteTextarea.style.resize = 'vertical';
        remoteTextarea.style.fontFamily = 'monospace';

        // Button Container for conflict resolution options.
        const buttonContainer = contentEl.createDiv({ cls: 'conflict-buttons' });
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'flex-end';
        buttonContainer.style.gap = '10px';
        buttonContainer.style.marginTop = '20px';

        // 'Keep Local Version' button.
        const keepLocalBtn = buttonContainer.createEl('button', { text: 'Keep Local Version' });
        keepLocalBtn.onclick = () => {
            this.close(); // Closes the modal.
            this.resolve('local'); // Resolves the promise with 'local' choice.
        };

        // 'Keep Remote Version' button.
        const keepRemoteBtn = buttonContainer.createEl('button', { text: 'Keep Remote Version' });
        keepRemoteBtn.onclick = () => {
            this.close(); // Closes the modal.
            this.resolve('remote'); // Resolves the promise with 'remote' choice.
        };

        // 'Try Auto-Merge' button.
        const mergeBtn = buttonContainer.createEl('button', { text: 'Try Auto-Merge' });
        mergeBtn.onclick = () => {
            this.close(); // Closes the modal.
            this.resolve('merge'); // Resolves the promise with 'merge' choice.
        };
    }

    // Presents the modal and returns a promise that resolves with the user's chosen resolution.
    askForResolution(): Promise<'local' | 'remote' | 'merge'> {
        return new Promise((resolve) => {
            this.resolve = resolve;
            this.open();
        });
    }
}

// Main plugin class extending Obsidian's Plugin.
export default class GitHubSyncPlugin extends Plugin {
    settings: GitHubSyncSettings;
    syncIntervalId: number | null = null; // ID for the auto-sync interval timer.
    statusBarItem: HTMLElement; // Reference to the plugin's status bar item.
    private apiBase = 'https://api.github.com'; // Base URL for GitHub API requests.
    public syncState: SyncState; // Tracks the current synchronization state.
    private debouncedSync: (syncType?: SyncType, filePath?: string) => void; // Debounced sync function to prevent rapid triggers.
    private debouncedSaveOnCloseSync: (file: TFile) => void; // Debounced function for sync-on-save behavior.
    private fileWatchers: Map<string, () => void> = new Map(); // Stores file watcher cleanup functions.
    public debouncedShowNotice: (message: string, type?: 'info' | 'success' | 'error', duration?: number) => void; // Debounced notice display function.

    // Called when the plugin is loaded.
    async onload() {
        console.log('Loading GitHub SyncMate plugin...');

        // Initialize syncState with default values.
        this.syncState = {
            inProgress: false,
            lastSync: 0, // Will be loaded from settings.
            pendingFiles: new Set(),
            fileMetadata: new Map(),
            pendingDeletions: new Map(),
            recentlyPushedFiles: new Map(),
            recentlyDeletedFromRemote: new Map(),
            lastActiveFile: null,
            remoteChangesPendingForActiveFiles: new Set(),
        };

        await this.loadPluginData(); // Loads settings and metadata from plugin data.

        // Enforce and save hard-coded settings (realtimeSync, syncOnSave) to false.
        this.settings.realtimeSync = false;
        this.settings.syncOnSave = false;
        await this.savePluginData(); // Persists the enforced settings.

        // Initialize UI components and set up event listeners before updating the status bar.
        this.setupUI();
        this.setupEventListeners();

        // Sets the initial status bar message based on current plugin settings.
        this.updateOverallStatusBar();

        // Displays a brief notice upon plugin load, if verbosity settings allow.
        if (this.settings.notificationVerbosity === 'verbose') {
            new Notice('GitHub SyncMate: Plugin Loaded and Ready.', 2000);
        }

        // Initializes the debounced notice helper for consistent notification display.
        this.debouncedShowNotice = customDebounce((message: string, type?: 'info' | 'success' | 'error', customDuration?: number) => {
            let duration = customDuration || 2000; // Default notice duration.

            // Adjusts duration based on notice type.
            if (type === 'success') {
                duration = customDuration || 2000;
            } else if (type === 'error') {
                duration = customDuration || 5000;
            } else if (type === 'info') {
                duration = customDuration || 3000;
            }

            new Notice(message, duration);
        }, 1000); // Debounce interval for the notice function.

        // Creates a debounced synchronization function to manage sync triggers.
        this.debouncedSync = customDebounce((syncType: SyncType = 'Auto Sync', filePath?: string) => {
            if (!this.syncState.inProgress) {
                console.log(`Debounced sync triggered (${syncType}).`);
                this.syncWithGitHub(syncType, filePath); // Initiates sync.
            } else {
                console.log(`Debounced sync (${syncType}): Sync already in progress, skipping.`);
            }
        }, 2000); // 2-second debounce for real-time like syncs.

        // Creates a debounced function for 'Save on Close' synchronization.
        this.debouncedSaveOnCloseSync = customDebounce(async (file: TFile) => {
            if (!this.syncState.inProgress && this.shouldSyncFile(file)) {
                const localFileState = (await this.getLocalFileStates()).get(file.path);
                const metadata = this.syncState.fileMetadata.get(file.path);

                // Checks if the local file has changed since its last known remote state.
                if (localFileState && metadata && localFileState.checksum !== metadata.remoteContentChecksum) {
                    console.log(`[SaveOnClose Sync] Triggering sync for ${file.path} due to active leaf change and local modifications.`);
                    this.syncState.pendingFiles.add(file.path); // Marks file as pending for push.
                    this.syncWithGitHub('Save on Close Sync', file.path); // Initiates sync for this file.
                } else {
                    console.log(`[SaveOnClose Sync] No changes detected for ${file.path} on active leaf change, skipping sync.`);
                }
            }
        }, 500); // Small debounce to prevent multiple triggers on rapid tab switching.

        // Initiates auto-sync on startup if enabled in settings.
        if (this.settings.autoSync) {
            console.log("GitHub SyncMate: Initiating sync on startup...");
            this.debouncedSync('Startup Sync'); // Performs an immediate initial sync.
            this.startAutoSync(); // Starts periodic auto-synchronization.
        }

        // Applies mobile-specific optimizations if the environment is mobile.
        if (this.isMobile()) {
            this.optimizeForMobile();
        }
    }

    // Called when the plugin is unloaded.
    onunload() {
        this.stopAutoSync(); // Stops the auto-sync interval.
        this.clearFileWatchers(); // Clears any active file watchers.
        console.log('GitHub SyncMate Plugin unloaded.');
    }

    // Sets up the plugin's user interface elements, including ribbon icon, status bar, commands, and context menus.
    private setupUI() {
        console.log('[Plugin Setup] setupUI method called.');

        // Adds a ribbon icon to trigger manual synchronization.
        this.addRibbonIcon('sync', 'GitHub SyncMate', () => {
            this.syncWithGitHub('Manual Sync'); // Initiates a manual sync.
        });

        this.statusBarItem = this.addStatusBarItem(); // Initializes the status bar item.

        // Adds commands to the Obsidian command palette.
        this.addCommand({
            id: 'sync-with-github',
            name: 'Sync with GitHub',
            callback: () => this.syncWithGitHub('Manual Sync')
        });

        this.addCommand({
            id: 'force-pull',
            name: 'Force Pull from GitHub',
            callback: () => this.forcePullFromGitHub()
        });

        this.addCommand({
            id: 'force-push',
            name: 'Force Push to GitHub',
            callback: () => this.forcePushToGitHub()
        });
        
        // Command for viewing single file history.
        this.addCommand({
            id: 'view-file-history',
            name: 'Show GitHub File History',
            checkCallback: (checking: boolean) => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile instanceof TFile && this.shouldSyncFile(activeFile)) {
                    if (!checking) {
                        this.openFileHistoryModal(activeFile);
                    }
                    return true;
                }
                return false;
            }
        });

        // Command for viewing folder history.
        this.addCommand({
            id: 'view-folder-history',
            name: 'Show GitHub Folder History',
            checkCallback: (checking: boolean) => {
                const activeFile = this.app.workspace.getActiveFile();
                let targetFolder: TFolder | null = null;

                if (activeFile instanceof TFolder) {
                    targetFolder = activeFile;
                } else if (activeFile instanceof TFile) {
                    targetFolder = activeFile.parent;
                }

                if (targetFolder) {
                    if (!checking) {
                        this.openFolderHistoryModal(targetFolder);
                    }
                    return true;
                }
                return false;
            }
        });
        
        // Registers a unified context menu for files and folders.
        this.registerEvent(
            this.app.workspace.on('file-menu', (menu, abstractFile) => {
                // Adds 'Show GitHub File History' to file context menu.
                if (abstractFile instanceof TFile && this.shouldSyncFile(abstractFile)) {
                    menu.addItem((item) => {
                        item.setTitle('Show GitHub File History')
                            .setIcon('git-compare')
                            .onClick(() => this.openFileHistoryModal(abstractFile));
                    });
                }
                // Adds 'Show GitHub Folder History' to folder context menu.
                else if (abstractFile instanceof TFolder) {
                    menu.addItem((item) => {
                        item.setTitle('Show GitHub Folder History')
                            .setIcon('folder-git-2')
                            .onClick(() => this.openFolderHistoryModal(abstractFile));
                    });
                }
            })
        );

        // Adds the plugin's settings tab.
        this.addSettingTab(new GitHubSyncSettingTab(this.app, this));
    }

    // Sets up event listeners for file system changes (modify, create, delete, rename).
    private setupEventListeners() {
        this.registerEvent(this.app.vault.on('modify', (file) => {
            if (file instanceof TFile && this.shouldSyncFile(file)) {
                this.onFileModified(file);
            }
        }));

        this.registerEvent(this.app.vault.on('create', (file) => {
            if (file instanceof TFile && this.shouldSyncFile(file)) {
                this.onFileCreated(file);
            }
        }));

        this.registerEvent(this.app.vault.on('delete', (file) => {
            if (file instanceof TFile && this.shouldSyncFile(file)) {
                this.onFileDeleted(file);
            }
        }));

        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            // Checks both new and old paths for relevance to synchronization.
            if (file instanceof TFile && (this.shouldSyncFile(file) || this.shouldSyncPath(oldPath))) {
                this.onFileRenamed(file, oldPath);
            }
        }));

        // Event listener for 'active-leaf-change' to handle 'Sync on Save' and pending pulls.
        this.registerEvent(this.app.workspace.on('active-leaf-change', async (leaf) => {
            const previouslyActiveFile = this.syncState.lastActiveFile;
            const currentActiveFile = (leaf?.view instanceof MarkdownView) ? leaf.view.file : null;

            if (previouslyActiveFile && previouslyActiveFile instanceof TFile && previouslyActiveFile !== currentActiveFile) {
                // Processes 'Sync on Save' for the file that was just deactivated.
                if (this.settings.syncOnSave && !this.settings.realtimeSync) {
                    console.log(`[Event Handler] Active leaf changed from ${previouslyActiveFile.path}. Checking for SaveOnClose sync.`);
                    this.debouncedSaveOnCloseSync(previouslyActiveFile); // Triggers debounced sync.
                }

                // Checks if the previously active file had pending remote changes and is now inactive.
                if (this.syncState.remoteChangesPendingForActiveFiles.has(previouslyActiveFile.path)) {
                    console.log(`[Event Handler] Previously active file ${previouslyActiveFile.path} is now inactive and had pending remote changes. Triggering pull.`);
                    const remoteFileMetadata = (await this.getRemoteFileStates())?.get(previouslyActiveFile.path);
                    if (remoteFileMetadata) {
                        try {
                            await this.downloadFile(remoteFileMetadata);
                            this.syncState.remoteChangesPendingForActiveFiles.delete(previouslyActiveFile.path); // Clears after successful pull.
                            this.debouncedShowNotice(`Remote changes for '${previouslyActiveFile.basename}' pulled successfully.`, 'success', 2000);
                        } catch (pullError) {
                            console.error(`[Event Handler] Failed to pull pending remote changes for ${previouslyActiveFile.path}:`, pullError);
                            this.debouncedShowNotice(`Failed to pull remote changes for '${previouslyActiveFile.basename}'. Check console.`, 'error');
                        }
                    } else {
                        console.warn(`[Event Handler] Could not find remote metadata for ${previouslyActiveFile.path} despite pending remote changes. Clearing pending status.`);
                        this.syncState.remoteChangesPendingForActiveFiles.delete(previouslyActiveFile.path); // Clears to avoid perpetual pending.
                    }
                }
            }
            // Updates the last active file reference.
            this.syncState.lastActiveFile = currentActiveFile;
        }));
    }

    // Handles local file modification events.
    private async onFileModified(file: TFile) {
        console.log(`[Event Handler] File modified: ${file.path}. Current Settings: RealtimeSync=${this.settings.realtimeSync}, SyncOnSave=${this.settings.syncOnSave}`);
        
        // Always updates metadata when a file is modified, irrespective of sync settings.
        await this.updateFileMetadata(file); // Updates local checksum and mtime.

        const localFileState = (await this.getLocalFileStates()).get(file.path);
        const metadata = this.syncState.fileMetadata.get(file.path);
        
        // Adds to pendingFiles only if the local content genuinely differs from the last known remote content.
        if (localFileState && metadata && localFileState.checksum !== metadata.remoteContentChecksum) {
            this.syncState.pendingFiles.add(file.path);
            console.log(`[Event Handler] Added ${file.path} to pending files for push (local content changed). Current pending: ${Array.from(this.syncState.pendingFiles).join(', ')}`);
        } else if (localFileState && metadata && localFileState.checksum === metadata.remoteContentChecksum) {
            // If local content matches remote, ensures it's not in pendingFiles.
            this.syncState.pendingFiles.delete(file.path);
            console.log(`[Event Handler] Removed ${file.path} from pending files (content matches remote).`);
        } else if (!metadata) { // Handles new files without existing metadata.
             this.syncState.pendingFiles.add(file.path);
             console.log(`[Event Handler] Added new file ${file.path} to pending files for push.`);
        }
        
        // Triggers debounced sync if real-time sync is enabled or sync-on-save is enabled.
        if (this.settings.realtimeSync || (this.settings.syncOnSave && !this.settings.realtimeSync)) {
            this.debouncedSync('Real-time sync', file.path);
        } else {
            console.log(`[Event Handler] Not triggering automated real-time sync for ${file.path}. RealtimeSync: ${this.settings.realtimeSync}.`);
        }
        console.log(`[Event Handler] Updated metadata for ${file.path}.`);
    }

    // Handles local file creation events.
    private async onFileCreated(file: TFile) {
        console.log(`[Event Handler] File created: ${file.path}. Current Settings: RealtimeSync=${this.settings.realtimeSync}, SyncOnSave=${this.settings.syncOnSave}`);
        
        // Always updates metadata when a file is created, irrespective of sync settings.
        await this.updateFileMetadata(file); // Updates local checksum and mtime.

        const metadata = this.syncState.fileMetadata.get(file.path);

        // Adds to pendingFiles only if the local content is not already in sync with a known remote version.
        if (metadata && metadata.localChecksum !== metadata.remoteContentChecksum) {
            this.syncState.pendingFiles.add(file.path);
            console.log(`[Event Handler] Added ${file.path} to pending files (new or locally changed). Current pending: ${Array.from(this.syncState.pendingFiles).join(', ')}`);
        } else if (metadata && metadata.localChecksum === metadata.remoteContentChecksum) {
            // If local content matches remote (e.g., just pulled), ensures it's not in pendingFiles.
            this.syncState.pendingFiles.delete(file.path);
            console.log(`[Event Handler] Removed ${file.path} from pending files (content matches remote after creation/pull).`);
        } else {
            // Fallback for truly new local files without remoteContentChecksum yet.
            this.syncState.pendingFiles.add(file.path);
            console.log(`[Event Handler] Added truly new local file ${file.path} to pending files.`);
        }
        
        // Triggers debounced sync if real-time sync is enabled or sync-on-save is enabled.
        if (this.settings.realtimeSync || (this.settings.syncOnSave && !this.settings.realtimeSync)) {
            this.debouncedSync('Real-time sync', file.path);
        } else {
            console.log(`[Event Handler] Not triggering automated real-time sync for ${file.path}. RealtimeSync: ${this.settings.realtimeSync}.`);
        }
        console.log(`[Event Handler] Updated metadata for ${file.path}.`);
    }

    // Handles local file deletion events.
    private async onFileDeleted(file: TFile) {
        console.log(`[Event Handler] File deleted locally: ${file.path}`);
        const metadata = this.syncState.fileMetadata.get(file.path);
        if (metadata && metadata.githubBlobSha) {
            // Marks for remote deletion only if the file had a corresponding remote version.
            this.syncState.pendingDeletions.set(file.path, metadata.githubBlobSha);
            console.log(`[Event Handler] Marked ${file.path} for remote deletion with SHA: ${metadata.githubBlobSha}`);
        } else {
            console.log(`[Event Handler] ${file.path} was not tracked with a remote SHA, not marking for remote deletion.`);
        }
        this.syncState.fileMetadata.delete(file.path); // Always removes from local metadata.
        this.syncState.pendingFiles.delete(file.path); // Ensures it's not marked as pending for push.
        this.syncState.remoteChangesPendingForActiveFiles.delete(file.path); // Removes from pending remote changes if deleted.

        // Triggers a sync if real-time or auto-sync is enabled to propagate the deletion.
        if (this.settings.realtimeSync || this.settings.autoSync) {
            this.debouncedSync('Real-time sync', file.path);
        }
        await this.savePluginData(); // Saves updated metadata and pending deletions.
    }

    // Handles local file renaming events.
    private async onFileRenamed(file: TFile, oldPath: string) {
        console.log(`[Event Handler] File renamed: ${oldPath} -> ${file.path}`);
        
        // Retrieves old metadata before deletion.
        const oldMetadata = this.syncState.fileMetadata.get(oldPath);

        // 1. Marks the old path for remote deletion if it was tracked.
        if (oldMetadata && oldMetadata.githubBlobSha) {
            this.syncState.pendingDeletions.set(oldPath, oldMetadata.githubBlobSha);
            console.log(`[Event Handler] Marked old path ${oldPath} for remote deletion due to rename.`);
        }
        
        // 2. Removes the old path from pending files and metadata.
        this.syncState.pendingFiles.delete(oldPath);
        this.syncState.fileMetadata.delete(oldPath);
        this.syncState.remoteChangesPendingForActiveFiles.delete(oldPath); // Removes old path from pending remote changes.
        console.log(`[Event Handler] Removed old path ${oldPath} from pending files and metadata.`);

        // 3. Creates/updates metadata for the new path, inheriting relevant info from the old.
        const newMetadata: FileMetadata = {
            path: file.path,
            githubBlobSha: oldMetadata?.githubBlobSha || '', // Inherits SHA from old path if it existed.
            lastModified: file.stat.mtime,
            localChecksum: await this.calculateChecksum(await this.app.vault.read(file)),
            remoteContentChecksum: oldMetadata?.remoteContentChecksum || '', // Inherits remote checksum.
            conflicted: false
        };
        this.syncState.fileMetadata.set(file.path, newMetadata);
        console.log(`[Metadata] Created new metadata for ${file.path} (from rename): ${JSON.stringify(newMetadata)}`);

        // 4. Marks the new file for push.
        this.syncState.pendingFiles.add(file.path);
        console.log(`[Event Handler] Added new path ${file.path} to pending files for push. Current pending: ${Array.from(this.syncState.pendingFiles).join(', ')}`);

        // Triggers synchronization.
        if (this.settings.realtimeSync || this.settings.autoSync) {
            this.debouncedSync('Real-time sync', file.path);
        }
        await this.savePluginData(); // Saves updated state.
    }

    // Updates the metadata for a given file.
    private async updateFileMetadata(file: TFile) {
        try {
            const content = await this.app.vault.read(file);
            const checksum = await this.calculateChecksum(content);

            // Retrieves existing metadata or initializes a new one if not found.
            let metadata = this.syncState.fileMetadata.get(file.path);

            if (!metadata) {
                // For a brand new local file or if metadata was lost.
                metadata = {
                    path: file.path,
                    githubBlobSha: '', // No remote SHA yet.
                    lastModified: file.stat.mtime,
                    localChecksum: checksum,
                    remoteContentChecksum: '', // No remote content checksum yet.
                    conflicted: false
                };
                console.log(`[Metadata] Created new metadata for ${file.path}: ${JSON.stringify(metadata)}`);
            } else {
                // Updates existing metadata with local changes.
                metadata.localChecksum = checksum;
                metadata.lastModified = file.stat.mtime;
                metadata.conflicted = false; // Resets conflict status on local modification.
                console.log(`[Metadata] Updated existing metadata for ${file.path}: ${JSON.stringify(metadata)}`);
            }

            this.syncState.fileMetadata.set(file.path, metadata);
            await this.savePluginData(); // Saves the updated metadata.
        } catch (error) {
            console.error(`[Metadata Error] Failed to update metadata for ${file.path}:`, error);
        }
    }

    // Calculates the SHA-256 checksum of file content.
    private async calculateChecksum(content: string): Promise<string> {
        if (typeof crypto !== 'undefined' && crypto.subtle) {
            const encoder = new TextEncoder();
            const data = encoder.encode(content);
            const hashBuffer = await crypto.subtle.digest('SHA-256', data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        } else {
            // Fallback for environments without Web Crypto API (less secure, but functional).
            let hash = 0;
            for (let i = 0; i < content.length; i++) {
                const char = content.charCodeAt(i);
                hash = ((hash << 5) - hash) + char;
                hash = hash & hash; // Converts to 32-bit integer.
            }
            return hash.toString();
        }
    }

    // Initiates the main synchronization process with GitHub.
    async syncWithGitHub(syncType: SyncType = 'Auto Sync', specificFilePath?: string) {
        if (!this.validateSettings() || this.syncState.inProgress) {
            if (this.syncState.inProgress) {
                this.debouncedShowNotice('Sync in progress, please wait.', 'info');
            }
            return;
        }

        this.syncState.inProgress = true;
        let success = true;
        let error: Error | null = null;
        const changesMade = {
            pushedCount: 0,
            pulledCount: 0,
            deletedLocallyCount: 0,
            deletedRemotelyCount: 0,
        };

        const isRealtime = syncType === 'Real-time sync' || syncType === 'Save on Close Sync';
        const isStartupSync = syncType === 'Startup Sync';
        const isQuietMode = this.settings.notificationVerbosity === 'quiet';
        const isStandardMode = this.settings.notificationVerbosity === 'standard';
        const isVerboseMode = this.settings.notificationVerbosity === 'verbose';

        try {
            // Updates status bar at the start of synchronization.
            if (isStartupSync) {
                this.updateStatusBar('Startup sync in progress... ⏳');
            } else if (isRealtime) {
                const fileName = specificFilePath ? this.app.metadataCache.getFirstLinkpathDest(specificFilePath, '')?.basename : '';
                this.updateStatusBar(`Syncing${fileName ? ' ' + fileName : ''}... ⏳`);
            } else { // Manual or Auto Sync.
                this.updateStatusBar(`Syncing (${syncType})... ⏳`);
            }

            // Displays pop-up notices for starting synchronization.
            if (isStartupSync) {
                this.debouncedShowNotice(`GitHub SyncMate: Starting initial vault synchronization...`, 'info', 2000);
            } else if (!isRealtime || isVerboseMode) {
                this.debouncedShowNotice(`GitHub SyncMate: Starting ${syncType.toLowerCase()}...`, 'info', 1500);
            }

            console.log(`[SyncWithGitHub] ${syncType}: Starting GitHub sync...`);
            console.log(`[SyncWithGitHub] Current pending files at start of sync: ${Array.from(this.syncState.pendingFiles).join(', ')}`);
            console.log(`[SyncWithGitHub] Current pending deletions at start of sync: ${Array.from(this.syncState.pendingDeletions.keys()).join(', ')}`);


            const localFiles = await this.getLocalFileStates();
            
            // Processes any pending deletions before other sync operations.
            changesMade.deletedRemotelyCount = await this.processPendingDeletions();

            // Re-fetches remote files after processing deletions to ensure data consistency.
            let remoteFiles = await this.getRemoteFileStates();

            // Detects and resolves conflicts.
            const conflicts = await this.detectConflicts(localFiles, remoteFiles);
            await this.resolveConflicts(conflicts, syncType);

            // Performs core synchronization operations (pushes, pulls, local deletions).
            const { pushedCount, pulledCount, deletedLocallyCount } = await this.performSync(localFiles, remoteFiles);
            changesMade.pushedCount = pushedCount;
            changesMade.pulledCount = pulledCount;
            changesMade.deletedLocallyCount = deletedLocallyCount;

            this.syncState.lastSync = Date.now();
            this.settings.lastSyncTime = this.syncState.lastSync;
            await this.savePluginData();

            // Manages notification logic at the end of synchronization.
            const totalChanges = changesMade.pushedCount + changesMade.pulledCount + changesMade.deletedLocallyCount + changesMade.deletedRemotelyCount;

            if (isStartupSync) {
                this.updateStatusBar('Vault synced ✨');
                this.debouncedShowNotice(`GitHub SyncMate: Vault synchronized. ${changesMade.pushedCount} files uploaded, ${changesMade.pulledCount} files downloaded.`, 'success', 3000);
            } else if (isRealtime) { // This block will not be hit due to hard-coding of realtimeSync to false
                if (isQuietMode) {
                    if (totalChanges > 0) {
                        console.log(`[SyncWithGitHub] Real-time sync completed with ${totalChanges} changes (quiet mode).`);
                    }
                } else if (totalChanges === 0) {
                    // No changes, no pop-up for real-time.
                } else if (totalChanges === 1) {
                    let successMessage = '';
                    const fileName = specificFilePath ? this.app.metadataCache.getFirstLinkpathDest(specificFilePath, '')?.basename : '';

                    if (changesMade.pushedCount === 1 && fileName) successMessage = `✅ '${fileName}' uploaded.`;
                    else if (changesMade.pulledCount === 1 && fileName) successMessage = `⬇️ '${fileName}' downloaded.`;
                    else if (changesMade.deletedRemotelyCount === 1) {
                        successMessage = fileName ? `🗑️ '${fileName}' deleted from GitHub.` : `🗑️ A file deleted from GitHub.`;
                    } else if (changesMade.deletedLocallyCount === 1) {
                        successMessage = fileName ? `🗑️ '${fileName}' deleted locally.` : `🗑️ A file deleted locally.;`
                    } else {
                        successMessage = `✅ 1 file synced.`;
                    }

                    if (successMessage) {
                        this.debouncedShowNotice(successMessage, 'success', 1500); // Fixed: Added 'success' type
                    }
                } else {
                    const message = `GitHub SyncMate: ${totalChanges} changes processed (${changesMade.pushedCount} uploaded, ${changesMade.pulledCount} downloaded).`;
                    this.debouncedShowNotice(message, 'success', 3000);
                }
            } else { // Manual or Auto Sync.
                let successMessage = `${syncType}: Sync completed.`;
                if (changesMade.pushedCount > 0) successMessage += ` Pushed ${changesMade.pushedCount} file(s).`;
                if (changesMade.pulledCount > 0) successMessage += ` Pulled ${changesMade.pulledCount} file(s).`;
                if (changesMade.deletedLocallyCount > 0) successMessage += ` Deleted ${changesMade.deletedLocallyCount} local file(s).`;
                if (changesMade.deletedRemotelyCount > 0) successMessage += ` Deleted ${changesMade.deletedRemotelyCount} remote file(s).`;
                if (totalChanges === 0) {
                    successMessage += ` No changes detected.`;
                }
                this.debouncedShowNotice(successMessage, 'success');
            }
            console.log(`[SyncWithGitHub] ${syncType}: GitHub sync completed successfully.`);

        }
        catch (e: any) {
            success = false;
            error = e;
            console.error('[SyncWithGitHub Error] Sync error:', error);
            
            // Displays prominent error notice regardless of verbosity.
            let errorFileName = specificFilePath ? this.app.metadataCache.getFirstLinkpathDest(specificFilePath, '')?.basename : '';
            const errorMessage = `GitHub SyncMate: ${isRealtime && errorFileName ? `Failed to sync '${errorFileName}'.` : 'Failed to sync changes.'} Error: ${error?.message || 'Unknown error'}. Please check your connection or plugin settings.`;
            this.debouncedShowNotice(errorMessage, 'error', 5000);
            this.updateStatusBar(isStartupSync ? 'Startup sync error ⚠️' : (isRealtime ? 'Sync Error! ❗' : 'Sync Failed!'));
        } finally {
            this.syncState.inProgress = false; // Resets sync in progress flag.
            await this.savePluginData(); // Ensures latest state is saved.
            this.updateOverallStatusBar(); // Updates the status bar.
        }
    }

    // Detects conflicts between local and remote file states.
    private async detectConflicts(localFiles: Map<string, any>, remoteFiles: Map<string, any> | null): Promise<Map<string, any>> {
        const conflicts = new Map();

        if (remoteFiles === null) {
            console.warn('[Conflict Detection] Skipping remote-based conflict detection due to unreliable remote file states.');
            for (const [path, localFile] of localFiles) {
                const metadata = this.syncState.fileMetadata.get(path);
                // If no metadata or local content changed from known remote content, assumes pending for push.
                if (!metadata || localFile.checksum !== metadata.remoteContentChecksum) {
                    this.syncState.pendingFiles.add(path);
                    console.log(`[Conflict Detection] Local file ${path} has changes or is new (no/outdated metadata). Adding to pending for push.`);
                }
            }
            return conflicts;
        }

        // Iterates through local files to identify pushes and conflicts.
        for (const [path, localFile] of localFiles) {
            const remoteFileMetadata = remoteFiles.get(path);
            let metadata = this.syncState.fileMetadata.get(path); // 'let' allows modification.

            // Scenario 1: File exists locally but not remotely (and is not a pending deletion).
            if (!remoteFileMetadata) {
                // Adds to pending only if not previously tracked remotely or not a pending deletion.
                if (!this.syncState.pendingDeletions.has(path) && (!metadata || !metadata.githubBlobSha)) {
                    console.log(`[Conflict Detection] New local file ${path} detected, will be pushed.`);
                    this.syncState.pendingFiles.add(path);
                } else {
                    console.log(`[Conflict Detection] File ${path} exists locally but is missing remotely (remote deletion detected or not tracked).`);
                }
                continue;
            }

            // If execution reaches here, the file exists both locally and remotely.
            if (!metadata) {
                // If no metadata exists, fetches remote content to establish initial state.
                console.log(`[Conflict Detection] No metadata for ${path} but exists locally and remotely. Fetching remote content to establish initial state.`);
                try {
                    const remoteContentData = await this.makeGitHubRequest(
                        `/repos/${this.settings.repoOwner}/${this.settings.repoName}/contents/${this.encodeFilePath(remoteFileMetadata.path)}?ref=${this.settings.branch}`
                    );
                    const remoteContent = this.decodeBase64(remoteContentData.content);
                    const remoteChecksum = await this.calculateChecksum(remoteContent);

                    // Creates new metadata based on the remote state.
                    const newMetadata: FileMetadata = {
                        path: path,
                        githubBlobSha: remoteFileMetadata.sha,
                        lastModified: localFile.mtime, // Uses local mtime for initial metadata.
                        localChecksum: localFile.checksum,
                        remoteContentChecksum: remoteChecksum,
                        conflicted: false
                    };
                    this.syncState.fileMetadata.set(path, newMetadata);
                    metadata = newMetadata; // Updates the local metadata reference.
                    console.log(`[Conflict Detection] Initial metadata established for ${path}.`);

                    // Re-evaluates local vs. remote based on fresh metadata.
                    if (localFile.checksum !== metadata.remoteContentChecksum) {
                        console.log(`[Conflict Detection] Local content differs from remote after initial metadata fetch for ${path}. Adding to pending for push.`);
                        this.syncState.pendingFiles.add(path);
                    } else {
                        console.log(`[Conflict Detection] Local content matches remote for ${path} after initial metadata fetch. Not adding to pending.`);
                        this.syncState.pendingFiles.delete(path); // Ensures it's not pending if matching.
                    }

                } catch (fetchError) {
                    console.error(`[Conflict Detection Error] Failed to fetch remote content for ${path} to resolve missing metadata:`, fetchError);
                    this.debouncedShowNotice(`Warning: Could not fetch remote content for '${path}'. Sync accuracy might be affected.`, 'error');
                    this.syncState.pendingFiles.add(path); // Defaults to pushing if remote content cannot be fetched.
                }
                continue; // Moves to the next file after handling missing metadata.
            }

            const localChanged = localFile.checksum !== metadata.remoteContentChecksum;
            const remoteChanged = remoteFileMetadata.sha !== metadata.githubBlobSha;
            const localPending = this.syncState.pendingFiles.has(path);

            console.log(`[Conflict Detection] For ${path}:`);
            console.log(`  Local Checksum: ${localFile.checksum}`);
            console.log(`  Metadata Remote Content Checksum: ${metadata.remoteContentChecksum}`);
            console.log(`  Local Changed: ${localChanged}`);
            console.log(`  Remote SHA: ${remoteFileMetadata.sha}`);
            console.log(`  Metadata GitHub Blob SHA: ${metadata.githubBlobSha}`);
            console.log(`  Remote Changed: ${remoteChanged}`);
            console.log(`  Local Pending: ${localPending}`);

            if (localChanged && remoteChanged) {
                console.warn(`[Conflict Detection] Potential conflict detected for ${path}. Fetching remote content for resolution.`);
                const remoteContentData = await this.makeGitHubRequest(
                    `/repos/${this.settings.repoOwner}/${this.settings.repoName}/contents/${this.encodeFilePath(remoteFileMetadata.path)}?ref=${this.settings.branch}`
                );
                const remoteContent = this.decodeBase64(remoteContentData.content);

                conflicts.set(path, {
                    local: localFile,
                    remote: { ...remoteFileMetadata, content: remoteContent },
                    metadata: metadata
                });
                this.syncState.pendingFiles.add(path);
                console.warn(`[Conflict Detection] Conflict added to list for ${path}`);
            } else if (localChanged && !remoteChanged) {
                console.log(`[Conflict Detection] File ${path} has local changes and no remote changes. Will push.`);
                this.syncState.pendingFiles.add(path);
            } else if (!localChanged && remoteChanged) {
                console.log(`[Conflict Detection] File ${path} has remote changes and no local pending changes. Will pull.`);
                this.syncState.pendingFiles.delete(path);
            } else {
                console.log(`[Conflict Detection] No significant changes or no conflict for ${path}.`);
                this.syncState.pendingFiles.delete(path);
            }
        }

        // Iterates through remote files to identify new remote files for local pull.
        for (const [path, remoteFileMetadata] of remoteFiles) {
            const localFile = localFiles.get(path);
            // Only considers pulling if it does not exist locally AND is not marked for deletion.
            if (!localFile && !this.syncState.pendingDeletions.has(path)) {
                console.log(`[Conflict Detection] File ${path} exists remotely but not locally. Will be pulled.`);
            }
        }
        return conflicts;
    }

    // Resolves detected conflicts based on the configured strategy or user input.
    private async resolveConflicts(conflicts: Map<string, any>, syncType: SyncType) {
        if (conflicts.size === 0) {
            console.log('[Conflict Resolution] No conflicts to resolve.');
            return;
        }
        
        const isRealtimeOrSaveOnClose = syncType === 'Real-time sync' || syncType === 'Save on Close Sync';
        const isQuietMode = this.settings.notificationVerbosity === 'quiet';

        if (!isQuietMode) {
            this.debouncedShowNotice(`Resolving ${conflicts.size} conflicts...`, 'info');
        }
        
        for (const [path, conflict] of conflicts.entries()) { // Uses .entries() for Map iteration.
            let effectiveResolution: 'local' | 'remote' | 'merge';

            if (this.settings.conflictResolution === 'ask' && !isRealtimeOrSaveOnClose) {
                const modal = new ConflictResolutionModal(this.app, path, conflict.local.content, conflict.remote.content);
                effectiveResolution = await modal.askForResolution(); // Awaits user's resolution choice.
                console.log(`[Conflict Resolution] User selected resolution for ${path}: ${effectiveResolution}`);
            } else if (this.settings.conflictResolution === 'ask' && isRealtimeOrSaveOnClose) {
                if (!isQuietMode) {
                    new Notice(`🚨 Conflict detected in '${path}'! Kept local version to avoid interruption. Please review and sync manually if needed.`, 8000);
                }
                this.updateStatusBar(`Conflict in '${path}' ⚠️`);
                effectiveResolution = 'local'; // Automatically keeps local version for real-time syncs.
            } else {
                effectiveResolution = this.settings.conflictResolution as 'local' | 'remote' | 'merge';
                console.log(`[Conflict Resolution] Applying automatic resolution for ${path}: ${effectiveResolution}`);
            }

            await this.applyConflictResolution(path, conflict, effectiveResolution);
        }
    }

    // Applies the chosen conflict resolution to a specific file.
    private async applyConflictResolution(path: string, conflict: any, resolution: 'local' | 'remote' | 'merge') {
        const file = this.app.vault.getAbstractFileByPath(path) as TFile;
        console.log(`[Apply Conflict Resolution] Applying resolution for ${path}: ${resolution}`);

        const isQuietMode = this.settings.notificationVerbosity === 'quiet';

        switch (resolution) {
            case 'local':
                this.syncState.pendingFiles.add(path); // Marks file for push.
                if (!isQuietMode) {
                    this.debouncedShowNotice(`Conflict resolved for ${path}: Kept local version.`, 'info');
                }
                break;

            case 'remote':
                if (file) {
                    await this.app.vault.modify(file, conflict.remote.content); // Overwrites local with remote content.
                    const checksum = await this.calculateChecksum(conflict.remote.content);
                    const metadata = this.syncState.fileMetadata.get(path);
                    if (metadata) {
                        metadata.localChecksum = checksum;
                        metadata.remoteContentChecksum = checksum;
                        metadata.githubBlobSha = conflict.remote.sha;
                    }
                    this.syncState.pendingFiles.delete(path); // Removes from pending as it's now in sync.
                    if (!isQuietMode) {
                        this.debouncedShowNotice(`Conflict resolved for ${path}: Kept remote version. (You may need to reopen the file to see changes.)`, 'info');
                    }
                } else {
                    // If local file doesn't exist, creates it with remote content.
                    const localPath = this.getLocalPath(path);
                    await this.ensureDirectoryExists(localPath);
                    await this.app.vault.create(localPath, conflict.remote.content);
                    const checksum = await this.calculateChecksum(conflict.remote.content);
                     const metadata = {
                        path: localPath,
                        githubBlobSha: conflict.remote.sha,
                        localChecksum: checksum,
                        remoteContentChecksum: checksum,
                        lastModified: Date.now(),
                        conflicted: false
                    };
                    this.syncState.fileMetadata.set(localPath, metadata);
                    if (!isQuietMode) {
                        this.debouncedShowNotice(`Conflict resolved for ${path}: Created local file with remote version. (You may need to reopen the file to see changes.)`, 'info');
                    }
                }
                break;

            case 'merge':
                const merged = await this.mergeContent(conflict.local.content, conflict.remote.content); // Merges content.
                if (file) {
                    await this.app.vault.modify(file, merged); // Updates local file with merged content.
                    this.syncState.pendingFiles.add(path); // Marks for push of the merged version.
                    if (!isQuietMode) {
                        this.debouncedShowNotice(`Conflict resolved for ${path}: Auto-merged. (This version will be pushed.)`, 'info');
                    }
                }
                break;
        }
        await this.savePluginData(); // Saves updated plugin data.
    }

    // Attempts a basic content merge for conflicted files.
    private async mergeContent(localContent: string, remoteContent: string): Promise<string> {
        // This is a simple line-by-line merge. For robust merging, consider a 3-way merge library.
        const localLines = localContent.split('\n');
        const remoteLines = remoteContent.split('\n');

        const mergedLines = [...localLines];

        // Adds lines from remote that are not present in local.
        let hasNewRemoteLines = false;
        for (const remoteLine of remoteLines) {
            if (!localLines.includes(remoteLine)) {
                mergedLines.push(remoteLine);
                hasNewRemoteLines = true;
            }
        }

        if (hasNewRemoteLines) {
            // Adds merge markers to indicate that a simple merge has occurred.
            return `<<<<<<< local version\n${localContent}\n=======\n${remoteContent}\n>>>>>>> remote version\n`;
        }
        return localContent; // If no unique remote lines, returns local content.
    }

    // Executes the core synchronization logic: pushing, pulling, and local deletions.
    private async performSync(localFiles: Map<string, any>, currentRemoteFiles: Map<string, any> | null): Promise<{ pushedCount: number; pulledCount: number; deletedLocallyCount: number }> {
        console.log('[Perform Sync] Performing sync operations...');
        const filesToPush = new Set<TFile>();
        const filesToPull = new Set<any>();
        const filesToDeleteLocally = new Set<TFile>();

        let pushedCount = 0;
        let pulledCount = 0;
        let deletedLocallyCount = 0;

        // Populates `filesToPush` based on the `pendingFiles` set.
        for (const path of this.syncState.pendingFiles) {
            const localFile = localFiles.get(path);
            
            if (localFile) {
                filesToPush.add(localFile.file);
                console.log(`[Perform Sync] File added to push queue: ${path}`);
            } else {
                console.warn(`[Perform Sync] Pending file ${path} not found locally, removing from pending and skipping push.`);
                this.syncState.pendingFiles.delete(path);
            }
        }

        // Executes push operations.
        for (const file of filesToPush) {
            try {
                const remotePath = this.getRemotePath(file.path);
                const metadata = this.syncState.fileMetadata.get(file.path);
                const activeFile = this.app.workspace.getActiveFile();
                const isActivelyEditing = activeFile && activeFile.path === file.path;

                // Proactively pulls only if not actively editing AND remote has genuinely changed.
                if (!isActivelyEditing && this.settings.realtimeSync && metadata) {
                    const remoteFileMetadata = currentRemoteFiles?.get(file.path);
                    if (remoteFileMetadata && remoteFileMetadata.sha !== metadata.githubBlobSha) {
                        console.log(`[Perform Sync] Proactively pulling ${file.path} before push due to detected remote changes (not actively editing).`);
                        await this.downloadFile(remoteFileMetadata);
                        localFiles.set(file.path, (await this.getLocalFileStates()).get(file.path));
                    } else {
                        console.log(`[Perform Sync] Skipping proactive pull for ${file.path}: No remote changes detected or actively editing.`);
                    }
                } else if (isActivelyEditing) {
                    console.log(`[Perform Sync] Skipping proactive pull for ${file.path} as it's actively being edited.`);
                }

                await this.uploadFile(file); // Uploads the file.
                this.syncState.pendingFiles.delete(file.path);
                this.syncState.recentlyPushedFiles.set(file.path, Date.now()); // Records successful push.
                pushedCount++;
                console.log(`[Perform Sync] Successfully pushed and removed from pending: ${file.path}`);
            } catch (error) {
                console.error(`[Perform Sync Error] Failed to push ${file.path}:`, error);
                this.debouncedShowNotice(`Failed to push ${file.path}. Check console for details.`, 'error');
            }
        }

        // Re-fetches remote files after push operations to ensure the most up-to-date state.
        console.log('[Perform Sync] Re-fetching remote file states after push operations...');
        currentRemoteFiles = await this.getRemoteFileStates(); 

        if (currentRemoteFiles !== null) { 
            // Identifies files to pull and files to delete locally based on the LATEST remote state.
            for (const [path, remoteFileMetadata] of currentRemoteFiles) { 
                const localFile = localFiles.get(path);
                const metadata = this.syncState.fileMetadata.get(path);

                // Case 1: File exists remotely but not locally (new remote file).
                if (!localFile) {
                    if (!this.syncState.pendingDeletions.has(path)) {
                        filesToPull.add(remoteFileMetadata);
                        console.log(`[Perform Sync] File ${path} exists remotely but not locally. Will pull.`);
                    } else {
                        console.log(`[Perform Sync] File ${path} exists remotely but is marked for pending local deletion. Skipping pull.`);
                    }
                    continue;
                }

                // Case 2: File exists both locally and remotely, checks for remote changes.
                if (metadata && remoteFileMetadata.sha !== metadata.githubBlobSha) {
                    const activeFile = this.app.workspace.getActiveFile();
                    const isActivelyEditing = activeFile && activeFile.path === path;

                    if (isActivelyEditing) {
                        // If actively editing, adds to pending remote changes and notifies.
                        if (!this.syncState.remoteChangesPendingForActiveFiles.has(path)) {
                            this.syncState.remoteChangesPendingForActiveFiles.add(path);
                            const fileName = this.app.metadataCache.getFirstLinkpathDest(path, '')?.basename || path;
                            if (this.settings.notificationVerbosity !== 'quiet') {
                                this.debouncedShowNotice(`Remote changes for '${fileName}' detected. Pull skipped to prevent overwrite. Close file to pull, or manually resolve.`, 'info', 5000);
                            }
                            console.log(`[Perform Sync] File ${path} has remote changes and is actively being edited. Adding to remoteChangesPendingForActiveFiles.`);
                        } else {
                            console.log(`[Perform Sync] File ${path} has remote changes and is actively being edited. Already noted as pending pull.`);
                        }
                    } else if (!filesToPush.has(localFile.file) || this.settings.conflictResolution === 'remote') {
                        filesToPull.add(remoteFileMetadata);
                        this.syncState.remoteChangesPendingForActiveFiles.delete(path);
                        console.log(`[Perform Sync] File ${path} has changed remotely and is not pending local push (or resolution is remote), and not actively edited. Will pull.`);
                    } else {
                        console.log(`[Perform Sync] File ${path} has remote changes but also pending local changes. Conflict was handled or will be pushed.`);
                    }
                }
            }

            // Identifies local files that were deleted remotely and schedules them for local deletion.
            for (const [path, localFileState] of localFiles) {
                const remoteFileMetadata = currentRemoteFiles.get(path); 
                const metadata = this.syncState.fileMetadata.get(path);

                const isRemoteMissing = !remoteFileMetadata;
                const wasTrackedRemotely = !!metadata?.githubBlobSha;
                const wasRecentlyPushed = this.syncState.recentlyPushedFiles.has(path) &&
                                          (Date.now() - this.syncState.recentlyPushedFiles.get(path)! < RECENTLY_PUSHED_GRACE_PERIOD_MS);


                console.log(`[Perform Sync - Local Delete Check] For ${path}: isRemoteMissing=${isRemoteMissing}, wasRecentlyPushed=${wasRecentlyPushed}, wasTrackedRemotely=${wasTrackedRemotely}`);

                if (isRemoteMissing && wasTrackedRemotely && !wasRecentlyPushed) {
                    filesToDeleteLocally.add(localFileState.file);
                    console.log(`[Perform Sync] File ${path} exists locally but not remotely (remote deletion detected). Will delete locally.`);
                } else if (isRemoteMissing && wasRecentlyPushed) {
                    console.warn(`[Perform Sync] File ${path} exists locally, was recently pushed, but still appears missing remotely. Skipping local deletion due to grace period.`);
                }
            }

            // Executes local deletions based on remote changes.
            for (const file of filesToDeleteLocally) {
                try {
                    await this.app.vault.delete(file);
                    this.syncState.fileMetadata.delete(file.path);
                    this.syncState.remoteChangesPendingForActiveFiles.delete(file.path);
                    deletedLocallyCount++;
                    console.log(`[Perform Sync] Successfully deleted local file ${file.path} (remote deletion detected).`);
                } catch (error) {
                    console.error(`[Perform Sync Error] Failed to delete local file ${file.path}:`, error);
                    this.debouncedShowNotice(`Failed to delete local file ${file.path}. Check console.`, 'error');
                }
            }
        } else {
            console.warn('[Perform Sync] Skipping remote-to-local operations (pulls and local deletions) due to unreliable remote file states after push.');
            this.debouncedShowNotice('Skipping some pull/delete operations due to network issues after push. Please check connection and try again.', 'error');
        }

        // Executes pull operations.
        if (currentRemoteFiles !== null) { 
            for (const remoteFileMetadata of filesToPull) {
                try {
                    await this.downloadFile(remoteFileMetadata);
                    pulledCount++;
                } catch (error) {
                    console.error(`[Perform Sync Error] Failed to pull ${remoteFileMetadata.path}:`, error);
                    this.debouncedShowNotice(`Failed to pull ${remoteFileMetadata.path}. Check console for details.`, 'error');
                }
            }
        }

        const now = Date.now();
        // Clears recently pushed files that are older than the grace period from cache.
        for (const [path, timestamp] of this.syncState.recentlyPushedFiles.entries()) {
            if (now - timestamp > RECENTLY_PUSHED_GRACE_PERIOD_MS) {
                this.syncState.recentlyPushedFiles.delete(path);
                console.log(`[Recently Pushed Cache] Cleared ${path} from cache.`);
            }
        }
        // Clears recently deleted from remote files that are older than the grace period from cache.
        for (const [path, timestamp] of this.syncState.recentlyDeletedFromRemote.entries()) {
            if (now - timestamp > RECENTLY_DELETED_GRACE_PERIOD_MS) {
                this.syncState.recentlyDeletedFromRemote.delete(path);
                    console.log(`[Recently Deleted Cache] Cleared ${path} from cache (expired).`);
                }
        }

        return { pushedCount, pulledCount, deletedLocallyCount };
    }

    // Processes files marked for pending deletion from the remote repository.
    private async processPendingDeletions(): Promise<number> {
        console.log(`[Process Pending Deletions] Processing ${this.syncState.pendingDeletions.size} pending deletions.`);
        const successfulDeletions = new Set<string>();
        let deletedRemotelyCount = 0;
        for (const [path, sha] of this.syncState.pendingDeletions.entries()) { // Uses .entries() for Map iteration.
            try {
                await this.deleteFileFromGitHub(path, sha); // Attempts to delete file from GitHub.
                successfulDeletions.add(path);
                deletedRemotelyCount++;
                console.log(`[Process Pending Deletions] Successfully deleted ${path} from GitHub.`);
            } catch (error) {
                console.error(`[Process Pending Deletions Error] Failed to delete ${path} from GitHub:`, error);
                this.debouncedShowNotice(`Failed to delete ${path} from GitHub. Check console for details.`, 'error');
            }
        }
        successfulDeletions.forEach(path => this.syncState.pendingDeletions.delete(path)); // Removes successfully deleted files from pending list.
        await this.savePluginData(); // Saves updated plugin data.
        return deletedRemotelyCount;
    }

    // Deletes a file from the GitHub repository, with retry logic.
    async deleteFileFromGitHub(filePath: string, initialFileSha: string, maxRetries = 3) { 
        const remotePath = this.getRemotePath(filePath);
        console.log(`[Delete] Attempting to delete ${filePath} from GitHub at ${remotePath}`);

        for (let i = 0; i < maxRetries; i++) {
            let currentRemoteSha: string | undefined; 

            try {
                // Fetches the latest SHA for the file on GitHub before attempting deletion.
                const existingFileResponse = await this.makeGitHubRequest(
                    `/repos/${this.settings.repoOwner}/${this.settings.repoName}/contents/${this.encodeFilePath(remotePath)}?ref=${this.settings.branch}`
                );
                if (existingFileResponse && !Array.isArray(existingFileResponse)) {
                    currentRemoteSha = existingFileResponse.sha ?? undefined;
                    console.log(`[Delete] Found latest SHA for ${filePath}: ${currentRemoteSha} (Attempt ${i + 1}/${maxRetries})`);
                }
            } catch (error: any) {
                if (error.status === 404) { 
                    console.log(`[Delete] File ${filePath} already does not exist on GitHub (404 during pre-check). Considering deletion successful.`);
                    this.syncState.recentlyDeletedFromRemote.set(filePath, Date.now()); // Marks as recently deleted.
                    return; // Exits if file is already gone.
                }
                console.error(`[Delete Error] Failed to get latest SHA for ${filePath} during pre-check (Attempt ${i + 1}/${maxRetries}):`, error);
                if (i < maxRetries - 1) { 
                    await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // Waits before retrying.
                    continue; 
                }
                throw error; // Re-throws if max retries reached.
            }

            if (!currentRemoteSha) {
                console.warn(`[Delete] Cannot delete ${filePath} from GitHub: No current SHA available after pre-check (Attempt ${i + 1}/${maxRetries}). Assuming it's already gone.`);
                this.syncState.recentlyDeletedFromRemote.set(filePath, Date.now());
                return; 
            }

            try {
                await this.makeGitHubRequest(
                    `/repos/${this.settings.repoOwner}/${this.settings.repoName}/contents/${this.encodeFilePath(remotePath)}`,
                    {
                        method: 'DELETE',
                        body: {
                            message: `Delete ${filePath} (Obsidian SyncMate)`,
                            sha: currentRemoteSha, 
                            branch: this.settings.branch
                        }
                    }
                );
                console.log(`[Delete] Successfully deleted ${filePath} from GitHub.`);
                this.syncState.recentlyDeletedFromRemote.set(filePath, Date.now());
                return; // Exits on successful deletion.
            } catch (error: any) {
                if (error.status === 409 && i < maxRetries - 1) { 
                    console.warn(`[Delete Error] Conflict (409) for ${filePath}, retrying attempt ${i + 1}/${maxRetries}...`);
                    await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); 
                } else if (error.status === 404) {
                    console.log(`[Delete] File ${filePath} was already deleted on GitHub (404 during delete attempt). Considering deletion successful.`);
                    this.syncState.recentlyDeletedFromRemote.set(filePath, Date.now());
                    return;
                }
                else {
                    console.error(`[Delete Error] Failed to delete ${filePath} from GitHub after ${i + 1} attempts:`, error);
                    throw error; 
                }
            }
        }
    }

    // Downloads a file from GitHub to the local vault.
    async downloadFile(fileInfo: { path: string; sha: string; }) { 
        console.log(`[Download] Attempting to download ${fileInfo.path} (SHA: ${fileInfo.sha})`);
        try {
            const encodedFilePath = this.encodeFilePath(fileInfo.path); // Encodes file path for URL.
            // Fetches the latest content using the branch reference.
            const downloadEndpoint = `/repos/${this.settings.repoOwner}/${this.settings.repoName}/contents/${encodedFilePath}?ref=${this.settings.branch}`;
            console.log(`[Download Debug] Constructed download endpoint: ${downloadEndpoint}`);

            const fileData = await this.makeGitHubRequest(
                downloadEndpoint 
            );
            const remoteContent = this.decodeBase64(fileData.content); // Decodes base64 content.

            const localPath = this.getLocalPath(fileInfo.path);
            await this.ensureDirectoryExists(localPath); // Ensures local directory structure exists.

            const existingFile = this.app.vault.getAbstractFileByPath(localPath);
            const remoteContentChecksum = await this.calculateChecksum(remoteContent);

            if (existingFile instanceof TFile) {
                const localContent = await this.app.vault.read(existingFile);
                if (localContent !== remoteContent) {
                    await this.app.vault.modify(existingFile, remoteContent); // Modifies existing file.
                    console.log(`[Download] Updated local file ${localPath} with remote version.`);
                } else {
                    console.log(`[Download] Local file ${localPath} content is identical to remote, skipping modification.`);
                }
            } else { 
                await this.app.vault.create(localPath, remoteContent); // Creates new local file.
                console.log(`[Download] Created new local file ${localPath}.`);
            }

            // Updates file metadata after successful download.
            const metadata = this.syncState.fileMetadata.get(localPath) || {
                path: localPath,
                githubBlobSha: '',
                localChecksum: '',
                remoteContentChecksum: '',
                lastModified: Date.now(),
                conflicted: false
            };

            metadata.githubBlobSha = fileInfo.sha; 
            metadata.remoteContentChecksum = remoteContentChecksum; 
            metadata.localChecksum = remoteContentChecksum; 
            metadata.lastModified = Date.now(); 
            this.syncState.fileMetadata.set(localPath, metadata);

            this.syncState.pendingFiles.delete(localPath); // Removes from pending files.
            this.syncState.remoteChangesPendingForActiveFiles.delete(localPath);
            console.log(`[Download] Removed ${localPath} from pending files after successful pull.`);

            await this.savePluginData(); // Persists updated plugin data.

        } catch (error) {
            console.error(`[Download Error] Error downloading file ${fileInfo.path}:`, error);
            throw error; 
        }
    }

    // Loads plugin data (settings and file metadata) from Obsidian's storage.
    async loadPluginData() {
        const storedData: PluginData = await this.loadData() || {};
        this.settings = Object.assign({}, DEFAULT_SETTINGS, storedData.settings);
        
        // Handles potential old metadata format during loading for backward compatibility.
        const loadedMetadata = new Map<string, FileMetadata>();
        if (storedData.fileMetadata) {
            for (const [path, data] of Object.entries(storedData.fileMetadata)) {
                loadedMetadata.set(path, {
                    path: path,
                    githubBlobSha: (data as any).githubBlobSha || (data as any).sha || '', 
                    localChecksum: (data as any).localChecksum || '',
                    remoteContentChecksum: (data as any).remoteContentChecksum || (data as any).remoteChecksum || '', 
                    lastModified: (data as any).lastModified || 0,
                    conflicted: (data as any).conflicted || false
                });
            }
        }
        this.syncState.fileMetadata = loadedMetadata;
        this.syncState.pendingDeletions = new Map(Object.entries(storedData.pendingDeletions || {}));
        this.syncState.remoteChangesPendingForActiveFiles = new Set(storedData.remoteChangesPendingForActiveFiles || []);

        this.syncState.lastSync = this.settings.lastSyncTime; // Syncs last sync time from settings.
        console.log('Plugin data loaded successfully.');
    }

    // Saves plugin data (settings and file metadata) to Obsidian's storage.
    async savePluginData() {
        const dataToSave: PluginData = {
            settings: this.settings,
            fileMetadata: Object.fromEntries(this.syncState.fileMetadata),
            pendingDeletions: Object.fromEntries(this.syncState.pendingDeletions),
            remoteChangesPendingForActiveFiles: Array.from(this.syncState.remoteChangesPendingForActiveFiles),
        };
        await this.saveData(dataToSave);
        console.log('Plugin data saved successfully.');
    }

    // Clears all active file watchers.
    private clearFileWatchers() {
        for (const [path, unwatch] of this.fileWatchers) {
            unwatch(); 
        }
        this.fileWatchers.clear();
    }

    // Checks if the current environment is likely a mobile device.
    private isMobile(): boolean {
        return (
            /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
            ('ontouchstart' in window) ||
            window.innerWidth <= 768
        );
    }

    // Applies optimizations specific to mobile environments.
    optimizeForMobile() {
        if (this.settings.autoSync && this.settings.syncInterval < 600000) { 
            this.settings.syncInterval = 600000; // Adjusts sync interval to 10 minutes for mobile.
            console.log('Mobile optimization: Sync interval adjusted to 10 minutes.');
        }
    }

    // Updates the text displayed in the Obsidian status bar.
    updateStatusBar(status: string) {
        this.statusBarItem.setText(`GitHub SyncMate: ${status}`);
    }

    // Updates the overall status bar message based on current sync state.
    public updateOverallStatusBar() {
        if (this.syncState.inProgress) {
            return; // Does not update if sync is already in progress.
        }

        if (this.settings.realtimeSync) {
            this.updateStatusBar('Real-time sync active ⚡');
        } else if (this.settings.autoSync) {
            this.updateStatusBar('Auto-sync active 🔄');
        } else {
            this.updateStatusBar('Idle');
        }
    }

    // Starts the periodic auto-synchronization.
    startAutoSync() {
        this.stopAutoSync(); // Stops any existing auto-sync interval first.
        console.log(`Starting auto-sync every ${this.settings.syncInterval / 60000} minutes.`);
        this.syncIntervalId = window.setInterval(() => {
            this.syncWithGitHub('Auto Sync'); // Triggers auto sync.
        }, this.settings.syncInterval);
        this.updateOverallStatusBar();
    }

    // Stops the periodic auto-synchronization.
    stopAutoSync() {
        if (this.syncIntervalId) {
            window.clearInterval(this.syncIntervalId);
            this.syncIntervalId = null;
            console.log('Auto-sync stopped.');
        }
        this.updateOverallStatusBar();
    }

    // Retrieves the current state (content and checksum) of local Markdown files.
    private async getLocalFileStates(): Promise<Map<string, any>> {
        const fileStates = new Map();
        const files = this.app.vault.getMarkdownFiles();

        for (const file of files) {
            if (this.shouldSyncFile(file)) {
                try {
                    const content = await this.app.vault.cachedRead(file); // Reads file content efficiently.
                    const checksum = await this.calculateChecksum(content);
                    fileStates.set(file.path, {
                        file: file,
                        content: content, 
                        checksum: checksum,
                        mtime: file.stat.mtime
                    });
                } catch (error) {
                    console.warn(`Failed to read local file ${file.path}:`, error);
                }
            }
        }
        return fileStates;
    }

    // Retrieves metadata (path, SHA, type) for remote files from GitHub.
    private async getRemoteFileStates(): Promise<Map<string, any> | null> { 
        const remoteStatesFromApi = new Map<string, any>(); 
        // Normalizes syncPath for API requests (removes leading/trailing slashes).
        const syncPathClean = this.settings.syncPath.trim().replace(/^\/|\/$/g, '');
        const syncPathForApi = syncPathClean === '' ? '' : syncPathClean;
        const syncPathForApiEncoded = this.encodeFilePath(syncPathForApi); // Encodes for URL.

        try {
            const contents = await this.makeGitHubRequest(
                `/repos/${this.settings.repoOwner}/${this.settings.repoName}/contents/${syncPathForApiEncoded}?ref=${this.settings.branch}`
            );

            if (Array.isArray(contents)) {
                await this.processRemoteDirectory(contents, remoteStatesFromApi); // Recursively processes directories.
            } else if (contents.type === 'file' && this.isMarkdownFile(contents.name)) {
                // Handles case where syncPath points directly to a file.
                remoteStatesFromApi.set(this.getLocalPath(contents.path), {
                    path: contents.path, 
                    sha: contents.sha,
                    type: contents.type
                });
            }
            
            const now = Date.now();
            const finalRemoteStates = new Map<string, any>(); 

            // Filters out recently deleted files and augments with recently pushed SHAs.
            for (const [path, fileInfoFromApi] of remoteStatesFromApi) {
                const deletedTimestamp = this.syncState.recentlyDeletedFromRemote.get(path);
                if (deletedTimestamp && (now - deletedTimestamp < RECENTLY_DELETED_GRACE_PERIOD_MS)) {
                    console.log(`[getRemoteFileStates] Filtering out ${path} from remote states: recently deleted.`);
                    continue; 
                }

                const metadata = this.syncState.fileMetadata.get(path);
                const pushedTimestamp = this.syncState.recentlyPushedFiles.get(path);

                if (pushedTimestamp && (now - pushedTimestamp < RECENTLY_PUSHED_GRACE_PERIOD_MS) && metadata?.githubBlobSha) {
                    if (metadata.githubBlobSha !== fileInfoFromApi.sha) {
                        // Prioritizes locally known SHA if recently pushed and remote is different.
                        console.log(`[getRemoteFileStates] Augmenting ${path} remote SHA with local metadata's newer SHA (${metadata.githubBlobSha} vs API ${fileInfoFromApi.sha}) due-to recent push.`);
                        finalRemoteStates.set(path, {
                            ...fileInfoFromApi,
                            sha: metadata.githubBlobSha 
                        });
                        continue; 
                    }
                }
                
                finalRemoteStates.set(path, fileInfoFromApi);
            }

            // Clears expired entries from recently pushed files cache.
            for (const [path, timestamp] of this.syncState.recentlyPushedFiles.entries()) {
                if (now - timestamp > RECENTLY_PUSHED_GRACE_PERIOD_MS) {
                    this.syncState.recentlyPushedFiles.delete(path);
                    console.log(`[Recently Pushed Cache] Cleared ${path} from cache.`);
                }
            }

            // Clears expired entries from recently deleted from remote cache.
            for (const [path, timestamp] of this.syncState.recentlyDeletedFromRemote.entries()) {
                if (now - timestamp > RECENTLY_DELETED_GRACE_PERIOD_MS) {
                    this.syncState.recentlyDeletedFromRemote.delete(path);
                    console.log(`[Recently Deleted Cache] Cleared ${path} from cache (expired).`);
                }
            }


            return finalRemoteStates; 
        } catch (error) {
            console.error('[getRemoteFileStates Error] Failed to get remote file states:', error);
            this.debouncedShowNotice('Failed to fetch remote file states. This may affect sync accuracy. Check your GitHub settings and network connection.', 'error');
            return null; // Returns null on error to indicate unreliable state.
        }
    }

    // Recursively processes items in a remote directory.
    private async processRemoteDirectory(items: any[], remoteStates: Map<string, any>) {
        for (const item of items) {
            if (item.type === 'file' && this.isMarkdownFile(item.name)) {
                remoteStates.set(this.getLocalPath(item.path), {
                    path: item.path, 
                    sha: item.sha, 
                    type: item.type
                });
            } else if (item.type === 'dir') {
                try {
                    const encodedItemPath = this.encodeFilePath(item.path); // Encodes directory path.
                    const subContents = await this.makeGitHubRequest(
                        `/repos/${this.settings.repoOwner}/${this.settings.repoName}/contents/${encodedItemPath}?ref=${this.settings.branch}`
                    );
                    if (Array.isArray(subContents)) {
                        await this.processRemoteDirectory(subContents, remoteStates); // Recursive call for subdirectories.
                    }
                } catch (error) {
                    console.warn(`Failed to process remote directory ${item.path}:`, error);
                }
            }
        }
    }

    // Forces a pull of all files from GitHub, overwriting local versions.
    async forcePullFromGitHub() {
        if (!this.validateSettings()) return;
        if (this.syncState.inProgress) {
            this.debouncedShowNotice('Sync in progress, please wait before forcing a pull.', 'info');
            return;
        }

        try {
            this.syncState.inProgress = true;
            this.updateStatusBar('Force pulling...');
            this.debouncedShowNotice('Starting force pull from GitHub...', 'info');

            const remoteFilesMetadata = await this.getRemoteFileStates(); 

            if (remoteFilesMetadata === null) {
                this.debouncedShowNotice('Force pull aborted: Could not retrieve remote file states due to network issues.', 'error');
                return;
            }

            let pulledCount = 0;
            for (const [path, remoteFileMetadata] of remoteFilesMetadata) {
                try {
                    await this.downloadFile(remoteFileMetadata); // Downloads each remote file.
                    pulledCount++;
                } catch (error) {
                    console.error(`[Force Pull Error] Failed to pull ${path}:`, error);
                    this.debouncedShowNotice(`Failed to pull ${path} during force pull. Check console.`, 'error');
                }
            }

            this.syncState.lastSync = Date.now();
            this.settings.lastSyncTime = this.syncState.lastSync;
            await this.savePluginData();

            this.updateStatusBar('Force pull complete');
            this.debouncedShowNotice(`Force pull completed. Pulled ${pulledCount} file(s).`, 'success');
            console.log('Force pull to GitHub completed.');
        }
        catch (error) {
            console.error('Force pull error:', error);
            this.debouncedShowNotice(`Force pull failed: ${error.message}`, 'error');
        } finally {
            this.syncState.inProgress = false;
            this.updateOverallStatusBar();
        }
    }

    // Forces a push of all local files to GitHub, overwriting remote versions.
    async forcePushToGitHub() {
        if (!this.validateSettings()) return;
        if (this.syncState.inProgress) {
            this.debouncedShowNotice('Sync in progress, please wait before forcing a push.', 'info');
            return;
        }

        try {
            this.syncState.inProgress = true;
            this.updateStatusBar('Force pushing...');
            this.debouncedShowNotice('Starting force push to GitHub...', 'info');

            const files = this.app.vault.getMarkdownFiles();
            let pushedCount = 0;

            for (const file of files) {
                if (this.shouldSyncFile(file)) {
                    try {
                        await this.uploadFile(file, 1); // Uploads each local file.
                        pushedCount++;
                    } catch (error) {
                        console.error(`[Force Push Error] Failed to push ${file.path}:`, error);
                        this.debouncedShowNotice(`Failed to push ${file.path} during force push. Check console.`, 'error');
                    }
                }
            }

            this.syncState.lastSync = Date.now();
            this.settings.lastSyncTime = this.syncState.lastSync;
            await this.savePluginData();

            this.updateStatusBar('Force push complete');
            this.debouncedShowNotice(`Force push completed. Pushed ${pushedCount} file(s).`, 'success');
            console.log('Force push to GitHub completed.');
        } catch (error) {
            console.error('Force push error:', error);
            this.debouncedShowNotice(`Force push failed: ${error.message}`, 'error');
        } finally {
            this.syncState.inProgress = false;
            this.updateOverallStatusBar();
        }
    }

    // Makes a request to the GitHub API with retry logic and error handling.
    async makeGitHubRequest(endpoint: string, options: any = {}, retries: number = 3, delay: number = 1000) {
        const url = `${this.apiBase}${endpoint}`;
        const headers = {
            'Authorization': `token ${this.settings.githubToken}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Obsidian-GitHub-SyncMate/1.1.0', // User-Agent for API identification.
            ...options.headers
        };

        const requestOptions = {
            url,
            method: options.method || 'GET',
            headers,
            ...options
        };

        if (options.body) {
            requestOptions.body = JSON.stringify(options.body);
            headers['Content-Type'] = 'application/json';
        }

        let attempts = 0;
        while (attempts < retries) {
            attempts++;
            try {
                const response = await requestUrl(requestOptions);
                if (response.status >= 400) {
                    console.error(`GitHub API Error: ${response.status} - ${response.text}`, response);
                    const error = new Error(`GitHub API Error: ${response.status} - ${response.text}`);
                    (error as any).status = response.status; 
                    throw error; // Throws error for status codes >= 400.
                }
                console.log(`GitHub Request successful for ${url} (Attempt ${attempts})`);
                return response.json;
            } catch (error: any) {
                console.error(`Request to ${url} failed (Attempt ${attempts}):`, error);
                
                // Defines conditions for retryable errors (network issues, server errors, 409 conflicts).
                const isRetryableError = 
                    (error.message && (error.message.includes('net::ERR_TIMED_OUT') || error.message.includes('Failed to fetch'))) ||
                    (error.status && [500, 502, 503, 504, 409].includes(error.status));

                if (attempts < retries && isRetryableError) {
                    console.log(`Retrying in ${delay / 1000} seconds...`);
                    await new Promise(res => setTimeout(res, delay));
                    delay *= 1.5; // Implements exponential backoff.
                } else {
                    // Re-throws if max retries reached or if it's a non-retryable error.
                    if ((error as any).request && (error as any).request.response) {
                        try {
                            const errorJson = JSON.parse((error as any).request.response);
                            if (errorJson.message) {
                                const newError = new Error(`GitHub API Error: ${errorJson.message} (Status: ${(error as any).status || 'unknown'})`);
                                (newError as any).status = (error as any).status;
                                throw newError;
                            }
                        } catch (parseError) {
                            // If JSON parsing fails, throws the original error.
                        }
                    }
                    throw error;
                }
            }
        }
        throw new Error('Max retries reached for GitHub request without successful response.');
    }

    // Determines if a given TFile should be synchronized based on sync path and file type.
    shouldSyncFile(file: TFile): boolean {
        const syncPath = this.settings.syncPath;
        const filePath = file.path; 

        // Normalizes syncPath by removing leading/trailing slashes.
        const normalizedSyncPath = syncPath.replace(/^\/|\/$/g, '');

        if (normalizedSyncPath === '') { 
            return this.isMarkdownFile(file.name); // Syncs all Markdown files if syncPath is root.
        }
        // Ensures filePath does not have a leading slash for comparison.
        const normalizedLocalPath = filePath.replace(/^\//, '');
        // Checks if the file path starts with the sync path and is a Markdown file.
        return normalizedLocalPath.startsWith(normalizedSyncPath + '/') && this.isMarkdownFile(file.name);
    }

    // Determines if a given path (string) should be synchronized.
    shouldSyncPath(path: string): boolean {
        const syncPath = this.settings.syncPath;
        // Normalizes syncPath by removing leading/trailing slashes.
        const normalizedSyncPath = syncPath.replace(/^\/|\/$/g, '');

        // Ensures path does not have a leading slash for comparison.
        const normalizedPath = path.replace(/^\//, '');

        if (normalizedSyncPath === '') {
            return this.isMarkdownFile(path); // Syncs all Markdown paths if syncPath is root.
        }
        // Checks if the path starts with the sync path and is a Markdown file.
        return normalizedPath.startsWith(normalizedSyncPath + '/') && this.isMarkdownFile(path);
    }

    // Converts a GitHub remote path to a local Obsidian vault path.
    getLocalPath(remotePath: string): string {
        const syncPath = this.settings.syncPath;
        const normalizedSyncPath = syncPath.replace(/^\/|\/$/g, ''); // Ensures no leading/trailing slashes.

        // Normalizes remotePath to ensure consistency.
        const normalizedRemotePath = remotePath.replace(/^\//, '');

        if (normalizedSyncPath === '') { 
            return normalizedRemotePath; // Returns remote path as is if syncPath is root.
        }
        
        // If remotePath is exactly the syncPath, it maps to the vault root locally.
        if (normalizedRemotePath === normalizedSyncPath) {
             return ''; // Maps to vault root.
        }

        const expectedPrefix = `${normalizedSyncPath}/`; 
        if (normalizedRemotePath.startsWith(expectedPrefix)) {
            return normalizedRemotePath.substring(expectedPrefix.length); // Removes sync path prefix.
        }
        return normalizedRemotePath; // Fallback, should ideally not be hit for synced files.
    }

    // Converts a local Obsidian vault path to a GitHub remote path.
    getRemotePath(localPath: string): string {
        // Normalizes localPath by removing leading slash.
        const normalizedLocalPath = localPath.replace(/^\//, '');
        // Normalizes syncPath by removing leading/trailing slashes.
        const normalizedSyncPath = this.settings.syncPath.replace(/^\/|\/$/g, '');

        if (normalizedSyncPath === '') { 
            return normalizedLocalPath; // Returns local path as is if syncPath is root.
        }
        // If local path is empty (vault root), it maps to syncPath.
        if (normalizedLocalPath === '') {
            return normalizedSyncPath;
        }
        return `${normalizedSyncPath}/${normalizedLocalPath}`; // Prepends sync path to local path.
    }

    // Checks if a filename has a Markdown extension.
    isMarkdownFile(filename: string): boolean {
        return filename.endsWith('.md') || filename.endsWith('.markdown');
    }

    // Encodes a string to Base64.
    encodeBase64(str: string): string {
        try {
            if (typeof Buffer !== 'undefined') {
                return Buffer.from(str, 'utf8').toString('base64');
            } else {
                const bytes = new TextEncoder().encode(str);
                let binaryString = '';
                for (let i = 0; i < bytes.length; i++) {
                    binaryString += String.fromCharCode(bytes[i]);
                }
                return btoa(binaryString);
            }
        } catch (e) {
            console.error("Error during encodeBase64:", e);
            throw new Error("Failed to encode string to base64.");
        }
    }

    // Decodes a Base64 string.
    decodeBase64(str: string): string {
        try {
            if (typeof Buffer !== 'undefined') {
                return Buffer.from(str, 'base64').toString('utf8');
            } else {
                let cleanedStr = str.replace(/[^A-Za-z0-9+/=]/g, '');

                while (cleanedStr.length % 4 !== 0) {
                    cleanedStr += '=';
                }
                
                console.log(`[decodeBase64] Cleaned string for atob: "${cleanedStr.substring(0, 100)}..." (length: ${cleanedStr.length})`); 
                
                const binaryString = atob(cleanedStr);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }
                return new TextDecoder('utf-8').decode(bytes);
            }
        } catch (e) {
            console.error("Error during decodeBase64:", e);
            if (e instanceof DOMException && e.name === 'InvalidCharacterError') {
                throw new Error("Failed to decode base64 string: Input contains invalid base64 characters or incorrect padding. Please ensure the content on GitHub is valid.");
            } else if (e instanceof URIError) {
                throw new Error("Failed to decode base64 string: Malformed URI sequence after base64 decoding. This suggests problematic UTF-8 characters.");
            } else {
                throw new Error(`Failed to decode base64 string: ${e.message || e}`);
            }
        }
    }

    // Validates essential GitHub synchronization settings.
    validateSettings(): boolean {
        if (!this.settings.githubToken || !this.settings.repoOwner || !this.settings.repoName) {
            this.debouncedShowNotice('Please configure GitHub settings first (Token, Owner, Repo Name).', 'error');
            return false;
        }
        return true;
    }

    // Tests the connection to the configured GitHub repository.
    async testConnection(): Promise<boolean> {
        if (!this.validateSettings()) {
            return false;
        }

        try {
            console.log(`[Test Connection] Attempting to connect to: /repos/${this.settings.repoOwner}/${this.settings.repoName}`);
            await this.makeGitHubRequest(
                `/repos/${this.settings.repoOwner}/${this.settings.repoName}`
            );
            this.debouncedShowNotice('✅ Connection successful!', 'success');
            console.log('[Test Connection] Connection successful.');
            return true;
        }
        catch (error) {
            console.error('[Test Connection] Connection failed:', error);
            this.debouncedShowNotice(`❌ Connection failed: ${error.message}`, 'error');
            throw new Error(`Connection failed: ${error.message}`);
        }
    }

    // Uploads a file to GitHub, handling existing files and retries.
    async uploadFile(file: TFile, maxRetries = 3) {
        const localContent = await this.app.vault.read(file);
        const remotePath = this.getRemotePath(file.path); // Derives remote path from local path.
        console.log(`[Upload] Attempting to upload ${file.path} to ${remotePath}`);

        let currentAttempt = 0;
        let chosenConflictResolution: 'local' | 'remote' | 'merge' | undefined = undefined; // Stores resolved conflict choice.

        while (currentAttempt < maxRetries) {
            currentAttempt++;
            let currentRemoteSha: string | undefined; 
            let remoteContentFromGitHub: string | undefined; 

            let metadata = this.syncState.fileMetadata.get(file.path);
            if (!metadata) {
                // Initializes metadata for a new file if not found.
                metadata = {
                    path: file.path,
                    githubBlobSha: '',
                    lastModified: file.stat.mtime,
                    localChecksum: await this.calculateChecksum(localContent),
                    remoteContentChecksum: '',
                    conflicted: false
                };
                this.syncState.fileMetadata.set(file.path, metadata);
                await this.savePluginData(); 
            }

            try {
                // Fetches the latest remote SHA and content at the beginning of each attempt.
                const encodedRemotePath = this.encodeFilePath(remotePath); // Encodes remote path.
                const existingFileResponse = await this.makeGitHubRequest(
                    `/repos/${this.settings.repoOwner}/${this.settings.repoName}/contents/${encodedRemotePath}?ref=${this.settings.branch}`
                );
                if (existingFileResponse && !Array.isArray(existingFileResponse)) {
                    currentRemoteSha = existingFileResponse.sha ?? undefined; 
                    remoteContentFromGitHub = this.decodeBase64(existingFileResponse.content);
                    metadata.remoteContentChecksum = await this.calculateChecksum(remoteContentFromGitHub);
                    metadata.githubBlobSha = currentRemoteSha ?? ''; 
                    await this.savePluginData(); 
                    console.log(`[Upload] Fetched latest remote SHA (${currentRemoteSha}) and content for ${file.path} (Attempt ${currentAttempt}/${maxRetries}).`);
                }
            } catch (error: any) {
                if (error.status === 404) { 
                    console.log(`[Upload] File ${remotePath} doesn't exist on GitHub, will create new.`);
                    currentRemoteSha = undefined; 
                    remoteContentFromGitHub = undefined; 
                } else {
                    console.error(`[Upload Error] Error fetching current SHA/content for ${remotePath} (Attempt ${currentAttempt}/${maxRetries}):`, error);
                    throw error; 
                }
            }

            const localChecksum = await this.calculateChecksum(localContent);
            let contentToPush = localContent; // Initializes with local content.
            let shaForPut: string | undefined = currentRemoteSha; // Initializes with current remote SHA.

            if (remoteContentFromGitHub !== undefined && localContent !== remoteContentFromGitHub) {
                console.warn(`[Upload] Detected new conflict for ${file.path} during upload attempt. Re-resolving.`);

                // Determines conflict resolution only if not already decided in a previous retry.
                if (chosenConflictResolution === undefined) {
                    let resolutionStrategy = this.settings.conflictResolution;
                    if (this.settings.realtimeSync || (this.settings.syncOnSave && !this.settings.realtimeSync)) {
                        resolutionStrategy = 'local'; // Automatic local resolution for these sync types.
                    } else if (resolutionStrategy === 'ask') {
                        const modal = new ConflictResolutionModal(this.app, file.path, localContent, remoteContentFromGitHub);
                        chosenConflictResolution = await modal.askForResolution(); // Stores the chosen resolution.
                        console.log(`[Upload Conflict Resolution] User selected resolution for ${file.path}: ${chosenConflictResolution}`);
                    } else {
                        chosenConflictResolution = resolutionStrategy as 'local' | 'remote' | 'merge'; // Stores automatic resolution.
                        console.log(`[Upload Conflict Resolution] Applying automatic resolution for ${file.path}: ${chosenConflictResolution}`);
                    }
                }
                
                // Applies the chosen conflict resolution for the current attempt.
                switch (chosenConflictResolution) { 
                    case 'local':
                        contentToPush = localContent;
                        shaForPut = currentRemoteSha; // Uses existing remote SHA.
                        break;
                    case 'remote':
                        contentToPush = remoteContentFromGitHub;
                        await this.app.vault.modify(file, remoteContentFromGitHub); // Overwrites local file.
                        console.log(`[Upload Conflict Resolution] Overwrote local ${file.path} with remote version.`);
                        shaForPut = currentRemoteSha; // Uses existing remote SHA.
                        break;
                    case 'merge':
                        contentToPush = await this.mergeContent(localContent, remoteContentFromGitHub);
                        await this.app.vault.modify(file, contentToPush); // Updates local file with merged content.
                        console.log(`[Upload Conflict Resolution] Merged ${file.path}.`);
                        shaForPut = currentRemoteSha; // Uses existing remote SHA.
                        break;
                    default: 
                        contentToPush = localContent;
                        console.warn(`[Upload Conflict Resolution] Unexpected resolution state. Defaulting to local.`);
                        shaForPut = currentRemoteSha;
                }
                
                const resolvedContentChecksum = await this.calculateChecksum(contentToPush);
                // Updates metadata with the *resolved* state for the current push attempt.
                metadata.githubBlobSha = shaForPut || ''; 
                metadata.lastModified = Date.now(); 
                metadata.localChecksum = resolvedContentChecksum;
                metadata.remoteContentChecksum = resolvedContentChecksum; 
                metadata.conflicted = false;
                await this.savePluginData(); 
            } else if (currentRemoteSha === undefined) {
                // If remote file doesn't exist, no SHA is needed for PUT (it will be created).
                shaForPut = undefined; 
            } else {
                // If local and remote content are identical, uses existing SHA for update.
                shaForPut = currentRemoteSha; 
            }

            const requestBody: any = {
                message: shaForPut ? `Update ${file.name} (Obsidian SyncMate)` : `Add ${file.name} (Obsidian SyncMate)`,
                content: this.encodeBase64(contentToPush),
                branch: this.settings.branch
            };

            if (shaForPut) {
                requestBody.sha = shaForPut;
                console.log(`[Upload] Using SHA for PUT request: ${shaForPut}`);
            } else {
                console.log('[Upload] No existing SHA found, creating new file.');
            }

            try {
                const encodedRemotePath = this.encodeFilePath(remotePath); // Encodes remote path.
                const result = await this.makeGitHubRequest(
                    `/repos/${this.settings.repoOwner}/${this.settings.repoName}/contents/${encodedRemotePath}`,
                    {
                        method: 'PUT',
                        body: requestBody
                    }
                );

                const finalLocalChecksum = await this.calculateChecksum(contentToPush);
                metadata.githubBlobSha = result.content.sha as string; 
                metadata.lastModified = file.stat.mtime; 
                metadata.localChecksum = finalLocalChecksum;
                metadata.remoteContentChecksum = finalLocalChecksum; 
                metadata.conflicted = false;

                this.syncState.fileMetadata.set(file.path, metadata); 
                await this.savePluginData();
                console.log(`[Upload] Successfully uploaded ${file.path} to GitHub with SHA: ${result.content.sha}`);
                return; // Exits loop on successful upload.
            } catch (error: any) {
                if (error.status === 409 && currentAttempt < maxRetries) { 
                    console.warn(`[Upload Error] Conflict (409) for ${file.path}, retrying attempt ${currentAttempt}/${maxRetries}...`);
                    await new Promise(resolve => setTimeout(resolve, 1000 * currentAttempt));
                } else {
                    console.error(`[Upload Error] Error uploading file ${file.path} after ${currentAttempt} attempts:`, error);
                    throw error;
                }
            }
        }
    }

    // Ensures that the directory structure for a given file path exists in the local vault.
    async ensureDirectoryExists(filePath: string) {
        const pathParts = filePath.split('/');
        pathParts.pop(); // Removes the file name to get only the directory path.

        if (pathParts.length === 0) return; // No directories to create if it's a root file.

        let currentPath = '';
        for (const part of pathParts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            const folder = this.app.vault.getAbstractFileByPath(currentPath);
            if (!folder) {
                try {
                    console.log(`Creating folder: ${currentPath}`);
                    await this.app.vault.createFolder(currentPath);
                } catch (error) {
                    if (!((error instanceof Error) && error.message.includes('Folder already exists'))) {
                        console.warn(`Path ${currentPath} exists but is a file, not a folder. This might cause issues.`);
                    }
                }
            } else if (folder instanceof TFile) {
                console.warn(`Path ${currentPath} exists but is a file, not a folder. This might cause issues.`);
            }
        }
    }

    // Encodes file paths for safe use in GitHub API URLs.
    public encodeFilePath(path: string): string { 
        // Splits path by '/', encodes each segment, then joins back with '/'.
        return path.split('/').map(segment => encodeURIComponent(segment)).join('/');
    }

    // Centralized confirmation modal for user prompts.
    public async showConfirmationModal(title: string, message: string): Promise<boolean> {
        return new Promise((resolve) => {
            const modal = new Modal(this.app);
            modal.titleEl.setText(title);

            const contentEl = modal.contentEl;
            contentEl.createEl('p', { text: message });

            const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
            buttonContainer.style.display = 'flex';
            buttonContainer.style.gap = '10px';
            buttonContainer.style.justifyContent = 'flex-end';
            buttonContainer.style.marginTop = '20px';

            const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
            cancelBtn.onclick = () => {
                modal.close();
                resolve(false);
            };

            const confirmBtn = buttonContainer.createEl('button', { text: 'Confirm' });
            confirmBtn.style.backgroundColor = 'var(--interactive-accent)';
            confirmBtn.style.color = 'var(--text-on-accent)';
            confirmBtn.onclick = () => {
                modal.close();
                resolve(true);
            };

            modal.open();
        });
    }

    // Opens the FileHistoryModal for a specific TFile.
    public openFileHistoryModal(file: TFile) {
        if (!this.validateSettings()) {
            this.debouncedShowNotice('Please configure GitHub settings to view history.', 'error');
            return;
        }
        new FileHistoryModal(this.app, this, file).open();
    }

    // Opens the FolderHistoryModal for a specific TFolder.
    public openFolderHistoryModal(folder: TFolder) {
        if (!this.validateSettings()) {
            this.debouncedShowNotice('Please configure GitHub settings to view folder history.', 'error');
            return;
        }
        new FolderHistoryModal(this.app, this, folder).open();
    }
}

// Modal for displaying the content of a specific commit version of a file.
class CommitContentModal extends Modal {
    content: string;
    fileName: string;
    sourcePath: string; // Original file path within Obsidian for correct Markdown rendering.
    plugin: GitHubSyncPlugin; // Reference to the main plugin instance.

    constructor(app: App, plugin: GitHubSyncPlugin, fileName: string, content: string, sourcePath: string) {
        super(app);
        this.plugin = plugin;
        this.fileName = fileName;
        this.content = content;
        this.sourcePath = sourcePath;
        this.titleEl.setText(`Content of: ${fileName}`);
    }

    // Configures the modal's appearance and renders content when opened.
    onOpen() {
        const { contentEl } = this;
        contentEl.empty(); // Clears existing content.

        // Makes the modal responsive.
        this.modalEl.style.width = '80vw';
        this.modalEl.style.maxWidth = '800px';
        this.modalEl.style.height = '80vh';
        this.modalEl.style.maxHeight = '800px';
        this.modalEl.style.display = 'flex';
        this.modalEl.style.flexDirection = 'column';

        // Container for Markdown rendering with scrollability.
        const markdownContainer = contentEl.createDiv({ cls: 'markdown-render-view' });
        markdownContainer.style.flexGrow = '1';
        markdownContainer.style.overflowY = 'auto';
        markdownContainer.style.padding = '10px';
        markdownContainer.style.border = '1px solid var(--background-modifier-border)';
        markdownContainer.style.borderRadius = '8px';
        markdownContainer.style.backgroundColor = 'var(--background-secondary)';

        // Renders the Markdown content.
        MarkdownRenderer.renderMarkdown(this.content, markdownContainer, this.sourcePath, this.plugin);
    }

    // Cleans up content when the modal is closed.
    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// Modal for displaying the version history of a specific file.
class FileHistoryModal extends Modal {
    plugin: GitHubSyncPlugin;
    file: TFile;
    private historyContainer: HTMLElement; // Container for the commit list.
    private loadingEl: HTMLElement; // Loading indicator element.

    constructor(app: App, plugin: GitHubSyncPlugin, file: TFile) {
        super(app);
        this.plugin = plugin;
        this.file = file;
        this.titleEl.setText(`Version History for: ${file.name}`);
    }

    // Configures the modal layout and initiates history fetching when opened.
    async onOpen() {
        const { contentEl } = this;
        contentEl.empty(); // Clears existing content.

        // Main container for the history list.
        const mainContainer = contentEl.createDiv({ cls: 'github-sync-history-main-container' });
        mainContainer.style.cssText = `
            display: flex;
            flex-direction: column;
            gap: 15px;
            max-height: 80vh; 
        `;

        this.loadingEl = mainContainer.createEl('div', { text: 'Loading history... ⏳', cls: 'github-sync-loading' });
        this.loadingEl.style.cssText = `
            font-style: italic;
            color: var(--text-muted);
            padding: 10px;
            text-align: center;
        `;
        
        // Scrollable container for the history list.
        this.historyContainer = mainContainer.createDiv({ cls: 'github-sync-history-list-container' });
        this.historyContainer.style.cssText = `
            flex-grow: 1;
            max-height: 75vh;
            overflow-y: auto;
            border: 1px solid var(--background-modifier-border);
            border-radius: 8px;
            padding: 10px;
        `;

        try {
            await this.fetchAndDisplayHistory(); // Fetches and displays file history.
        } catch (error) {
            console.error('Error fetching file history:', error);
            this.loadingEl.setText(`Failed to load history: ${error.message}. Please check console.`);
            this.loadingEl.style.color = 'var(--text-error)';
        }
    }

    // Placeholder for cleanup when the modal is closed.
    onClose() {
        // Any cleanup if needed.
    }

    // Fetches and displays the commit history for the associated file.
    private async fetchAndDisplayHistory() {
        this.loadingEl.setText('Loading history... ⏳');
        this.historyContainer.empty(); // Clears any previous history list.

        const remotePath = this.plugin.getRemotePath(this.file.path);
        const branch = this.plugin.settings.branch;

        try {
            const commits = await this.plugin.makeGitHubRequest(
                `/repos/${this.plugin.settings.repoOwner}/${this.plugin.settings.repoName}/commits?path=${this.plugin.encodeFilePath(remotePath)}&sha=${branch}`
            );

            this.loadingEl.remove(); // Removes the loading indicator once data is fetched.

            if (!Array.isArray(commits) || commits.length === 0) {
                this.historyContainer.createEl('p', { text: 'No version history found for this file on GitHub.', cls: 'github-sync-info' });
                this.historyContainer.style.cssText = `
                    font-style: italic;
                    color: var(--text-muted);
                    padding: 10px;
                    text-align: center;
                `;
                return;
            }

            for (const commit of commits) {
                const commitEl = this.historyContainer.createDiv({ cls: 'github-sync-commit-item' });
                commitEl.style.cssText = `
                    display: flex;
                    flex-direction: column;
                    padding: 8px;
                    border: 1px solid var(--background-modifier-border);
                    border-radius: 8px;
                    margin-bottom: 5px;
                    background-color: var(--background-secondary); 
                `;

                const headerEl = commitEl.createDiv(); 
                headerEl.style.cssText = 'display: flex; justify-content: space-between; align-items: center;';

                const messageEl = headerEl.createEl('div', { text: commit.commit.message, cls: 'github-sync-commit-message' }); 
                messageEl.style.cssText = 'font-weight: bold; margin-bottom: 4px; flex-grow: 1;';

                const shaEl = headerEl.createEl('div', { text: `SHA: ${commit.sha.substring(0, 7)}`, cls: 'github-sync-commit-sha' }); 
                shaEl.style.cssText = 'font-family: monospace; font-size: 0.85em; color: var(--text-muted); margin-left: 10px;';
                
                const authorEl = commitEl.createEl('div', { text: `Author: ${commit.commit.author.name}`, cls: 'github-sync-commit-author' }); 
                authorEl.style.cssText = 'font-size: 0.9em; color: var(--text-normal);';

                const dateEl = commitEl.createEl('div', { text: `Date: ${new Date(commit.commit.author.date).toLocaleString()}`, cls: 'github-sync-commit-date' }); 
                dateEl.style.cssText = 'font-size: 0.9em; color: var(--text-normal);';

                const actionsEl = commitEl.createDiv({ cls: 'github-sync-commit-actions' }); 
                actionsEl.style.cssText = 'display: flex; gap: 8px; margin-top: 8px; justify-content: flex-end;';

                const viewBtn = actionsEl.createEl('button', { text: 'View' });
                viewBtn.style.cssText = `
                    background-color: var(--interactive-accent);
                    color: var(--text-on-accent);
                    border: none;
                    border-radius: 6px;
                    padding: 6px 12px;
                    cursor: pointer;
                    transition: background-color 0.2s ease;
                `;
                viewBtn.onmouseover = (e) => (e.target as HTMLElement).style.backgroundColor = 'var(--interactive-accent-hover)';
                viewBtn.onmouseout = (e) => (e.target as HTMLElement).style.backgroundColor = 'var(--interactive-accent)';
                viewBtn.onclick = () => this.viewVersionContent(commit.sha, remotePath); // Views content of this version.

                const restoreBtn = actionsEl.createEl('button', { text: 'Restore' });
                restoreBtn.style.cssText = `
                    background-color: var(--background-modifier-error); 
                    color: var(--text-on-accent);
                    border: none;
                    border-radius: 6px;
                    padding: 6px 12px;
                    cursor: pointer;
                    transition: background-color 0.2s ease;
                `;
                restoreBtn.onmouseover = (e) => (e.target as HTMLElement).style.backgroundColor = 'var(--background-modifier-error-hover)';
                restoreBtn.onmouseout = (e) => (e.target as HTMLElement).style.backgroundColor = 'var(--background-modifier-error)';
                restoreBtn.onclick = () => this.restoreVersion(commit.sha, remotePath); // Restores this version.
            }
        } catch (error) {
            console.error('Failed to fetch and display history:', error);
            this.loadingEl.setText(`Error fetching history: ${error.message}.`);
            this.loadingEl.style.color = 'var(--text-error)';
        }
    }

    // Fetches and displays the content of a specific file version from GitHub.
    private async viewVersionContent(commitSha: string, remotePath: string) {
        try {
            this.plugin.debouncedShowNotice(`Fetching content for ${commitSha.substring(0, 7)}...`, 'info', 1500);
            const fileData = await this.plugin.makeGitHubRequest(
                `/repos/${this.plugin.settings.repoOwner}/${this.plugin.settings.repoName}/contents/${this.plugin.encodeFilePath(remotePath)}?ref=${commitSha}`
            );
            const content = this.plugin.decodeBase64(fileData.content);

            // Opens a new modal to display the content.
            new CommitContentModal(this.app, this.plugin, this.file.name, content, this.file.path).open();

        } catch (error: any) {
            console.error(`Error viewing version ${commitSha}:`, error);
            let errorMessage = `Failed to view version: ${error.message}`;
            if (error.status === 404) {
                errorMessage = `Version not found: The file may not exist at this path in commit ${commitSha.substring(0, 7)}.`;
            }
            this.plugin.debouncedShowNotice(errorMessage, 'error', 4000);
        }
    }

    // Restores a specific version of the file to the local vault.
    private async restoreVersion(commitSha: string, remotePath: string) {
        const confirmed = await this.plugin.showConfirmationModal( // Uses centralized confirmation modal.
            'Confirm Restore Version',
            `Are you sure you want to restore "${this.file.name}" to the version from commit ${commitSha.substring(0, 7)}? This will overwrite your local file and create a NEW commit on GitHub to revert its content.`
        );

        if (!confirmed) {
            this.plugin.debouncedShowNotice('Restore cancelled.', 'info', 2000);
            return;
        }

        try {
            this.plugin.debouncedShowNotice(`Restoring "${this.file.name}" to version ${commitSha.substring(0, 7)}...`, 'info', 2000);
            const fileData = await this.plugin.makeGitHubRequest(
                `/repos/${this.plugin.settings.repoOwner}/${this.plugin.settings.repoName}/contents/${this.plugin.encodeFilePath(remotePath)}?ref=${commitSha}`
            );
            const historicalContent = this.plugin.decodeBase64(fileData.content);

            await this.app.vault.modify(this.file, historicalContent); // Overwrites local file.
            
            // The plugin's existing modify event handler will mark this as pending for push, creating a revert commit.
            this.plugin.debouncedShowNotice(`Successfully restored "${this.file.name}". It will be pushed to GitHub shortly.`, 'success', 4000);
            this.close(); // Closes the history modal after restoring.
        } catch (error: any) {
            console.error(`Error restoring version ${commitSha}:`, error);
            let errorMessage = `Failed to restore version: ${error.message}`;
            if (error.status === 404) {
                errorMessage = `Version not found: The file may not exist at this path in commit ${commitSha.substring(0, 7)}.`;
            }
            this.plugin.debouncedShowNotice(errorMessage, 'error', 5000);
        }
    }
}

// Modal for displaying the version history of a specific folder.
class FolderHistoryModal extends Modal {
    plugin: GitHubSyncPlugin;
    folder: TFolder;
    private historyContainer: HTMLElement; // Container for the commit list.
    private loadingEl: HTMLElement; // Loading indicator element.

    constructor(app: App, plugin: GitHubSyncPlugin, folder: TFolder) {
        super(app);
        this.plugin = plugin;
        this.folder = folder;
        // Sets the modal title.
        this.titleEl.setText(`GitHub Folder History: ${folder.name || 'Vault Root'}`);
    }

    // Configures the modal layout and initiates folder history fetching.
    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        const mainContainer = contentEl.createDiv({ cls: 'github-sync-folder-history-main-container' });
        mainContainer.style.cssText = `
            display: flex;
            flex-direction: column;
            gap: 15px;
            max-height: 80vh;
        `;

        this.loadingEl = mainContainer.createEl('div', { text: 'Loading folder history... ⏳', cls: 'github-sync-loading' });
        this.loadingEl.style.cssText = `
            font-style: italic;
            color: var(--text-muted);
            padding: 10px;
            text-align: center;
        `;

        this.historyContainer = mainContainer.createDiv({ cls: 'github-sync-history-list-container' });
        this.historyContainer.style.cssText = `
            flex-grow: 1;
            max-height: 75vh;
            overflow-y: auto;
            border: 1px solid var(--background-modifier-border);
            border-radius: 8px;
            padding: 10px;
        `;

        try {
            await this.fetchAndDisplayFolderHistory(); // Fetches and displays folder history.
        } catch (error) {
            console.error('Error fetching folder history:', error);
            this.loadingEl.setText(`Failed to load folder history: ${error.message}. Please check console.`);
            this.loadingEl.style.color = 'var(--text-error)';
        }
    }

    // Placeholder for cleanup when the modal is closed.
    onClose() {
        // Any cleanup if needed.
    }

    // Fetches and displays the commit history for the associated folder.
    private async fetchAndDisplayFolderHistory() {
        this.loadingEl.setText('Loading folder history... ⏳');
        this.historyContainer.empty();

        const folderRemotePath = this.plugin.getRemotePath(this.folder.path);
        const branch = this.plugin.settings.branch;

        try {
            const commits = await this.plugin.makeGitHubRequest(
                `/repos/${this.plugin.settings.repoOwner}/${this.plugin.settings.repoName}/commits?path=${this.plugin.encodeFilePath(folderRemotePath)}&sha=${branch}`
            );

            this.loadingEl.remove();

            if (!Array.isArray(commits) || commits.length === 0) {
                this.historyContainer.createEl('p', { text: 'No version history found for this folder on GitHub.', cls: 'github-sync-info' });
                this.historyContainer.style.cssText = `
                    font-style: italic;
                    color: var(--text-muted);
                    padding: 10px;
                    text-align: center;
                `;
                return;
            }

            for (const commit of commits) {
                const commitEl = this.historyContainer.createDiv({ cls: 'github-sync-commit-item' });
                // Applies styling for the main commit item.
                commitEl.style.cssText = `
                    display: flex;
                    flex-direction: column;
                    padding: 8px;
                    border: 1px solid var(--background-modifier-border);
                    border-radius: 8px;
                    margin-bottom: 10px; 
                    background-color: var(--background-secondary); 
                `;

                // Displays basic commit information.
                const headerEl = commitEl.createDiv(); 
                headerEl.style.cssText = 'display: flex; justify-content: space-between; align-items: center;';

                const messageEl = headerEl.createEl('div', { text: commit.commit.message, cls: 'github-sync-commit-message' }); 
                messageEl.style.cssText = 'font-weight: bold; margin-bottom: 4px; flex-grow: 1;';

                const shaEl = headerEl.createEl('div', { text: `SHA: ${commit.sha.substring(0, 7)}`, cls: 'github-sync-commit-sha' }); 
                shaEl.style.cssText = 'font-family: monospace; font-size: 0.85em; color: var(--text-muted); margin-left: 10px;';
                
                const authorEl = commitEl.createEl('div', { text: `Author: ${commit.commit.author.name}`, cls: 'github-sync-commit-author' }); 
                authorEl.style.cssText = 'font-size: 0.9em; color: var(--text-normal);';

                const dateEl = commitEl.createEl('div', { text: `Date: ${new Date(commit.commit.author.date).toLocaleString()}`, cls: 'github-sync-commit-date' }); 
                dateEl.style.cssText = 'font-size: 0.9em; color: var(--text-normal);';
                
                // Placeholder for files, to be populated by detailed fetch.
                const filesContainer = commitEl.createDiv({ cls: 'github-sync-files-container' });
                filesContainer.setText('Loading changed files...');
                filesContainer.style.cssText = `
                    margin-top: 10px;
                    padding-top: 10px;
                    border-top: 1px solid var(--background-modifier-border-hover);
                `;


                // Fetches detailed commit information to get the list of changed files.
                try {
                    const detailedCommit = await this.plugin.makeGitHubRequest(
                        `/repos/${this.plugin.settings.repoOwner}/${this.plugin.settings.repoName}/commits/${commit.sha}`
                    );
                    
                    filesContainer.empty(); // Clears "loading" text.

                    const relevantFiles = detailedCommit.files.filter((file: any) => 
                        file.filename.startsWith(folderRemotePath === '' ? '' : `${folderRemotePath}/`) && this.plugin.isMarkdownFile(file.filename)
                    );
                    
                    if (relevantFiles.length > 0) {
                        for (const file of relevantFiles) {
                            const fileChangeItemEl = filesContainer.createDiv({ cls: 'github-sync-file-change-item' });
                            fileChangeItemEl.style.cssText = `
                                display: flex;
                                flex-direction: column;
                                padding: 6px 10px; 
                                border: 1px solid var(--background-modifier-border-hover); 
                                border-radius: 6px;
                                margin-bottom: 5px; 
                                background-color: var(--background-primary); 
                            `;
                            
                            let fileNameDisplay = file.filename.substring(folderRemotePath.length).replace(/^\//, '');
                            let statusIcon = '';
                            let statusColor = 'var(--text-normal)';

                            switch (file.status) {
                                case 'added': statusIcon = '➕'; statusColor = 'var(--text-success)'; break;
                                case 'modified': statusIcon = '✏️'; statusColor = 'var(--text-normal)'; break;
                                case 'removed': statusIcon = '➖'; statusColor = 'var(--text-error)'; break;
                                case 'renamed':
                                    statusIcon = '🔄';
                                    statusColor = 'var(--text-accent)';
                                    const oldName = file.previous_filename.substring(folderRemotePath.length).replace(/^\//, '');
                                    fileNameDisplay = `${oldName} → ${fileNameDisplay}`;
                                    break;
                                default: statusIcon = 'ℹ️';
                            }
                            
                            // Displays file info and action buttons on one line.
                            const fileItemHeader = fileChangeItemEl.createDiv();
                            fileItemHeader.style.cssText = 'display: flex; justify-content: space-between; align-items: center; width: 100%;';

                            const fileInfoSpan = fileItemHeader.createEl('span');
                            fileInfoSpan.style.cssText = 'flex-grow: 1; margin-right: 10px;';
                            fileInfoSpan.innerHTML = `<span style="color: ${statusColor}; margin-right: 5px;">${statusIcon}</span> <span style="font-weight: 500;">${fileNameDisplay}</span>`;

                            const actionsEl = fileItemHeader.createDiv({ cls: 'github-sync-file-actions' });
                            actionsEl.style.cssText = 'display: flex; gap: 8px;'; 
                            
                            if (file.status !== 'removed') {
                                const viewBtn = actionsEl.createEl('button', { text: 'View' });
                                viewBtn.style.cssText = `
                                    background-color: var(--interactive-accent);
                                    color: var(--text-on-accent);
                                    border: none;
                                    border-radius: 6px;
                                    padding: 6px 12px;
                                    cursor: pointer;
                                    transition: background-color 0.2s ease;
                                `;
                                viewBtn.onmouseover = (e) => (e.target as HTMLElement).style.backgroundColor = 'var(--interactive-accent-hover)';
                                viewBtn.onmouseout = (e) => (e.target as HTMLElement).style.backgroundColor = 'var(--interactive-accent)';
                                viewBtn.onclick = () => this.viewFileContentFromCommit(commit.sha, file.filename);

                                const restoreBtn = actionsEl.createEl('button', { text: 'Restore' });
                                restoreBtn.style.cssText = `
                                    background-color: var(--background-modifier-error); 
                                    color: var(--text-on-accent);
                                    border: none;
                                    border-radius: 6px;
                                    padding: 6px 12px;
                                    cursor: pointer;
                                    transition: background-color 0.2s ease;
                                `;
                                restoreBtn.onmouseover = (e) => (e.target as HTMLElement).style.backgroundColor = 'var(--background-modifier-error-hover)';
                                restoreBtn.onmouseout = (e) => (e.target as HTMLElement).style.backgroundColor = 'var(--background-modifier-error)';
                                restoreBtn.onclick = () => this.restoreFileFromCommit(commit.sha, file.filename);
                            }
                        }
                    } else {
                        filesContainer.createEl('p', { text: 'No files changed in this commit within this folder.', cls: 'github-sync-no-files-changed' });
                        filesContainer.style.cssText += 'font-style: italic; color: var(--text-muted);';
                    }
                } catch (detailedCommitError) {
                    console.error(`Failed to fetch details for commit ${commit.sha}:`, detailedCommitError);
                    filesContainer.setText('Error loading changed files.');
                    filesContainer.style.color = 'var(--text-error)';
                }
            }
        } catch (error) {
            console.error('Failed to fetch and display folder history:', error);
            this.loadingEl.setText(`Error fetching folder history: ${error.message}.`);
            this.loadingEl.style.color = 'var(--text-error)';
        }
    }

    // Views the content of a specific file from a given commit in the folder history.
    private async viewFileContentFromCommit(commitSha: string, fileRemotePathAtCommit: string) {
        try {
            this.plugin.debouncedShowNotice(`Fetching content for ${fileRemotePathAtCommit} at commit ${commitSha.substring(0, 7)}...`, 'info', 1500);
            const fileData = await this.plugin.makeGitHubRequest(
                `/repos/${this.plugin.settings.repoOwner}/${this.plugin.settings.repoName}/contents/${this.plugin.encodeFilePath(fileRemotePathAtCommit)}?ref=${commitSha}`
            );
            const content = this.plugin.decodeBase64(fileData.content);

            const localFilePath = this.plugin.getLocalPath(fileRemotePathAtCommit);
            new CommitContentModal(this.app, this.plugin, fileRemotePathAtCommit.split('/').pop() || 'Unnamed File', content, localFilePath).open();

        } catch (error: any) {
            console.error(`Error viewing file ${fileRemotePathAtCommit} at commit ${commitSha}:`, error);
            let errorMessage = `Failed to view content: ${error.message}`;
            if (error.status === 404) {
                errorMessage = `Content not found. The file may have been renamed or deleted before this commit.`;
            } else if (error.message.includes('Failed to decode base64')) {
                 errorMessage = `Failed to decode file content. This may indicate a non-text file or corrupted content.`;
            }
            this.plugin.debouncedShowNotice(errorMessage, 'error', 5000);
        }
    }

    // Restores a specific file from a given commit within the folder history.
    private async restoreFileFromCommit(commitSha: string, fileRemotePathAtCommit: string) {
        const fileName = fileRemotePathAtCommit.split('/').pop() || fileRemotePathAtCommit;
        const confirmed = await this.plugin.showConfirmationModal(
            'Confirm Restore Version',
            `Are you sure you want to restore "${fileName}" to its state from commit ${commitSha.substring(0, 7)}? This will overwrite your current local file (or create it if deleted). The change will be pushed to GitHub on the next sync.`
        );
    
        if (!confirmed) {
            this.plugin.debouncedShowNotice('Restore cancelled.', 'info', 2000);
            return;
        }
    
        try {
            this.plugin.debouncedShowNotice(`Restoring "${fileName}"...`, 'info', 2000);
            const fileData = await this.plugin.makeGitHubRequest(
                `/repos/${this.plugin.settings.repoOwner}/${this.plugin.settings.repoName}/contents/${this.plugin.encodeFilePath(fileRemotePathAtCommit)}?ref=${commitSha}`
            );
            const historicalContent = this.plugin.decodeBase64(fileData.content);
    
            const localPath = this.plugin.getLocalPath(fileRemotePathAtCommit);
            const existingFile = this.app.vault.getAbstractFileByPath(localPath);
    
            if (existingFile instanceof TFile) {
                await this.app.vault.modify(existingFile, historicalContent); // Modifies existing file.
            } else {
                await this.plugin.ensureDirectoryExists(localPath);
                await this.app.vault.create(localPath, historicalContent); // Creates new file.
            }
            
            this.plugin.debouncedShowNotice(`Successfully restored "${fileName}". It will be uploaded on the next sync.`, 'success', 4000);
    
        } catch (error: any) {
            console.error(`Error restoring file ${fileRemotePathAtCommit} from commit ${commitSha}:`, error);
            this.plugin.debouncedShowNotice(`Failed to restore file: ${error.message}`, 'error', 5000);
        }
    }
}

// Settings tab for the GitHub SyncMate plugin.
class GitHubSyncSettingTab extends PluginSettingTab {
    plugin: GitHubSyncPlugin; 

    constructor(app: App, plugin: GitHubSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    // Checks if the environment is mobile.
    private isMobile(): boolean {
        return (
            /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
            ('ontouchstart' in window) ||
            window.innerWidth <= 768
        );
    }

    // Displays the settings interface.
    display(): void {
        const { containerEl } = this;
        containerEl.empty(); // Clears previous content.

        containerEl.createEl('h2', { text: 'GitHub SyncMate Settings' });

        // GitHub Configuration Section.
        containerEl.createEl('h3', { text: 'GitHub Configuration' });

        new Setting(containerEl)
            .setName('GitHub Personal Access Token')
            .setDesc('Your GitHub Personal Access Token (PAT). This is essential for authentication and requires \'repo\' scope.')
            .addText(text => {
                text
                    .setPlaceholder('ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')
                    .setValue(this.plugin.settings.githubToken)
                    .onChange(async (value) => {
                        this.plugin.settings.githubToken = value;
                        await this.plugin.savePluginData(); 
                    });
                text.inputEl.type = 'password'; // Hides the token input.
            });

        new Setting(containerEl)
            .setName('Repository Owner')
            .setDesc('The GitHub username or organization that owns the repository (e.g., your-username or your-org).')
            .addText(text => text
                .setPlaceholder('e.g., your-username or your-org')
                .setValue(this.plugin.settings.repoOwner)
                .onChange(async (value) => {
                    this.plugin.settings.repoOwner = value;
                    await this.plugin.savePluginData();
                }));

        new Setting(containerEl)
            .setName('Repository Name')
            .setDesc('The name of your GitHub repository (e.g., \'my-obsidian-vault\').')
            .addText(text => text
                .setPlaceholder('e.g., my-obsidian-vault')
                .setValue(this.plugin.settings.repoName)
                .onChange(async (value) => {
                    this.plugin.settings.repoName = value;
                    await this.plugin.savePluginData();
                }));

        new Setting(containerEl)
            .setName('Branch')
            .setDesc('The specific branch in your GitHub repository to synchronize with (e.g., main, master, develop).')
            .addText(text => text
                .setPlaceholder('main')
                .setValue(this.plugin.settings.branch)
                .onChange(async (value) => {
                    this.plugin.settings.branch = value;
                    await this.plugin.savePluginData();
                }));

        new Setting(containerEl)
            .setName('Sync Path')
            .setDesc('The subfolder within your GitHub repository to synchronize (e.g., \'notes\', \'daily-journal\'). Leave this field blank to sync with the repository root.')
            .addText(text => text
                .setPlaceholder('e.g., notes/Daily')
                .setValue(this.plugin.settings.syncPath)
                .onChange(async (value) => {
                    // Normalizes syncPath by trimming and removing leading/trailing slashes.
                    this.plugin.settings.syncPath = value.trim().replace(/^\/|\/$/g, '');
                    await this.plugin.savePluginData();
                }));

        new Setting(containerEl)
            .setName('Test GitHub Connection')
            .setDesc('Verifies your GitHub Personal Access Token and repository settings to ensure connectivity.')
            .addButton(button => button
                .setButtonText('Test Connection')
                .setCta()
                .onClick(async () => {
                    button.setButtonText('Testing...');
                    button.setDisabled(true);

                    try {
                        await this.plugin.testConnection();
                        button.setButtonText('✅ Success');
                    } catch (error) {
                        button.setButtonText('❌ Failed');
                    }

                    setTimeout(() => {
                        button.setButtonText('Test Connection');
                        button.setDisabled(false);
                    }, 2000);
                }));

        // Sync Behavior Section.
        containerEl.createEl('h3', { text: 'Sync Behavior' });

        new Setting(containerEl)
            .setName('Real-time Sync')
            .setDesc('Enables synchronization of notes with GitHub as you type. This feature is currently disabled and reserved for future development.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.realtimeSync)
                .onChange(async (value) => {
                    this.plugin.settings.realtimeSync = value;
                    await this.plugin.savePluginData();
                    this.plugin.updateOverallStatusBar();
                })
                .setDisabled(true));

        new Setting(containerEl)
            .setName('Sync on Save')
            .setDesc('Triggers a synchronization every time a file is saved in Obsidian. This feature is currently disabled.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncOnSave)
                .onChange(async (value) => {
                    this.plugin.settings.syncOnSave = value;
                    await this.plugin.savePluginData();
                })
                .setDisabled(true));

        new Setting(containerEl)
            .setName('Auto Sync')
            .setDesc('Automatically synchronizes your vault with GitHub at regular, configurable intervals.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSync)
                .onChange(async (value) => {
                    this.plugin.settings.autoSync = value;
                    await this.plugin.savePluginData();
                    if (value) {
                        this.plugin.startAutoSync();
                        this.plugin.syncWithGitHub('Auto Sync'); 
                    } else {
                        this.plugin.stopAutoSync();
                    }
                    this.plugin.updateOverallStatusBar();
                }));

        new Setting(containerEl)
            .setName('Sync Interval')
            .setDesc('Defines how often (in minutes) the plugin should automatically synchronize with GitHub.')
            .addSlider(slider => slider
                .setLimits(1, 60, 1)
                .setValue(this.plugin.settings.syncInterval / 60000)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.syncInterval = value * 60000;
                    await this.plugin.savePluginData();
                    if (this.plugin.settings.autoSync) {
                        this.plugin.startAutoSync(); 
                    }
                }));

        // Conflict Resolution Section.
        containerEl.createEl('h3', { text: 'Conflict Resolution' });

        new Setting(containerEl)
            .setName('Conflict Resolution Strategy')
            .setDesc('Selects the default method for resolving conflicts when a file is modified both locally and remotely.')
            .addDropdown(dropdown => dropdown
                .addOption('ask', 'Ask me each time')
                .addOption('local', 'Keep Local Version')
                .addOption('remote', 'Prefer GitHub Version')
                .addOption('merge', 'Attempt Auto-Merge')
                .setValue(this.plugin.settings.conflictResolution)
                .onChange(async (value: 'local' | 'remote' | 'merge' | 'ask') => {
                    this.plugin.settings.conflictResolution = value;
                    await this.plugin.savePluginData();
                }));

        // Notifications Section.
        containerEl.createEl('h3', { text: 'Notifications' });

        new Setting(containerEl)
            .setName('Notification Verbosity')
            .setDesc('Controls the level of detail for synchronization notifications displayed by the plugin.')
            .addDropdown(dropdown => dropdown
                .addOption('quiet', 'Quiet')
                .addOption('standard', 'Standard')
                .addOption('verbose', 'Verbose')
                .setValue(this.plugin.settings.notificationVerbosity)
                .onChange(async (value: 'quiet' | 'standard' | 'verbose') => {
                    this.plugin.settings.notificationVerbosity = value;
                    await this.plugin.savePluginData();
                }));

        // Advanced Operations Section.
        containerEl.createEl('h3', { text: 'Advanced Operations' });

        new Setting(containerEl)
            .setName('Force Pull from GitHub')
            .setDesc('⚠️ **DANGER ZONE:** Downloads all files from your GitHub repository, **overwriting all local versions**. Any unsaved local changes will be permanently lost. Use with extreme caution.')
            .addButton(button => button
                .setButtonText('Force Pull')
                .setWarning()
                .onClick(async () => {
                    const confirmed = await this.plugin.showConfirmationModal( 
                        'Confirm Force Pull Confirmation',
                        'This action will download and overwrite ALL local files with versions from GitHub. Any unsaved local changes will be lost. Are you absolutely sure you want to proceed?'
                    );

                    if (confirmed) {
                        button.setButtonText('Pulling...');
                        button.setDisabled(true);

                        try {
                            await this.plugin.forcePullFromGitHub();
                            button.setButtonText('✅ Done');
                        } catch (error) {
                            button.setButtonText('❌ Failed');
                        }

                        setTimeout(() => {
                            button.setButtonText('Force Pull');
                            button.setDisabled(false);
                        }, 2000);
                    }
                }));

        new Setting(containerEl)
            .setName('Force Push to GitHub')
            .setDesc('⚠️ **DANGER ZONE:** Uploads all local files to your GitHub repository, **overwriting all remote changes**. Any changes made by others on GitHub will be permanently lost. Use with extreme caution.')
            .addButton(button => button
                .setButtonText('Force Push')
                .setWarning()
                .onClick(async () => {
                    const confirmed = await this.plugin.showConfirmationModal( 
                        'Confirm Force Push Confirmation',
                        'This action will upload and overwrite ALL files on GitHub with your local versions. Any changes made by others will be lost. Are you absolutely sure you want to proceed?'
                    );

                    if (confirmed) {
                        button.setButtonText('Pushing...');
                        button.setDisabled(true);

                        try {
                            await this.plugin.forcePushToGitHub();
                            button.setButtonText('✅ Done');
                        } catch (error) {
                            button.setButtonText('❌ Failed');
                        }

                        setTimeout(() => {
                            button.setButtonText('Force Push');
                            button.setDisabled(false);
                        }, 2000);
                    }
                }));

        // Sync Status & Info Section.
        containerEl.createEl('h3', { text: 'Sync Status & Info' });

        const statusContainer = containerEl.createDiv({ cls: 'sync-status' });

        // Displays current synchronization status.
        const lastSyncTime = this.plugin.settings.lastSyncTime;
        const lastSyncText = lastSyncTime ?
            `Last sync: ${new Date(lastSyncTime).toLocaleString()}` :
            'Never synced';
        statusContainer.createEl('div', {
            text: lastSyncText,
            cls: 'setting-item-description'
        });

        const pendingFilesCount = this.plugin.syncState?.pendingFiles?.size || 0;
        const pendingFilesText = `Pending files for upload: ${pendingFilesCount}`;
        const pendingFilesEl = statusContainer.createEl('div', {
            text: pendingFilesText,
            cls: 'setting-item-description'
        });

        new Setting(statusContainer)
            .setName('Refresh Status')
            .setDesc('Updates the displayed last synchronization time and pending file count.')
            .addButton(button => button
                .setButtonText('Refresh')
                .onClick(() => {
                    this.display(); // Re-renders the settings display to update status.
                }));

        // About This Plugin Section.
        containerEl.createEl('h3', { text: 'About This Plugin' });

        containerEl.createEl('p', { text: 'This Obsidian plugin provides robust synchronization of your Markdown notes with a GitHub repository, offering version control and backup capabilities for your digital garden.' });
        containerEl.createEl('p', { text: 'Plugin Version: 1.0.0' });
        containerEl.createEl('p', { text: 'Compatibility: ✅ Android, iOS, Windows, Mac, Linux' });

        // Support & Contribution Section.
        containerEl.createEl('h3', { text: 'Support & Contribution' });

        containerEl.createEl('p', { text: 'For support, bug reports, or feature requests, please visit the official ' })
            .createEl('a', { text: 'GitHub repository', href: 'https://github.com/cybawizz/GitHubSyncMate' })
            .setAttr('target', '_blank'); // Opens link in a new tab.
        containerEl.createEl('p', { text: 'Consider supporting ongoing development via ' })
            .createEl('a', { text: 'Buy Me a Coffee', href: 'https://buymeacoffee.com/cybawizz' })
            .setAttr('target', '_blank'); // Opens link in a new tab.
    }
}

// Custom debounce function to limit the rate at which a function can be called.
function customDebounce<T extends (...args: any[]) => void>(func: T, wait: number, immediate?: boolean): T {
    let timeout: NodeJS.Timeout | null;
    return function(this: any, ...args: any[]) {
        const context = this;
        const later = function() {
            timeout = null;
            if (!immediate) func.apply(context, args);
        };
        const callNow = immediate && !timeout;
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(later, wait);
        if (callNow) func.apply(context, args);
    } as T;
}
