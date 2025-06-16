# Obsidian GitHub SyncMate

**Seamless, Automated GitHub Synchronization for Obsidian.md**

## 🚀 Overview

The **Obsidian GitHub SyncMate** plugin integrates your Obsidian.md notes with GitHub's version control. It provides automated, reliable synchronization, backup, and supports collaborative workflows across all your devices.

### Why Choose GitHub SyncMate?

- **Reliable Version Control:** Track every change to your Markdown notes via GitHub. Easily revisit or restore previous file states.
    
- **Automated Cloud Backup:** Securely store your entire vault on GitHub, protecting against data loss.
    
- **Streamlined Collaboration:** Share and co-edit notes efficiently using a central GitHub repository.
    
- **Universal Access:** Maintain a consistent, up-to-date Obsidian experience across Android, iOS, Windows, Mac, and Linux.
    

## ✨ Key Capabilities

- **Flexible Synchronization Modes:**
    
    - **Manual Sync:** Sync on demand with a click or command.
        
    - **Automated Sync:** Background synchronization at custom intervals.
        
    - **Startup Sync:** Ensures your vault is current upon Obsidian launch.
        
    - **Close-on-Save Sync:** Automatically pushes changes when you exit Obsidian.
        
    - _(Note: Real-time and save-triggered sync features are disabled for stability in this release.)_
        
- **Intelligent Conflict Management:** When local and remote changes conflict, SyncMate offers:
    
    - **Interactive Resolution:** A modal for visual comparison and choice (local, remote, or auto-merge).
        
    - **Automated Preferences:** Configure default behaviors to automatically resolve conflicts.
        
- **Precise Sync Control:** Define your GitHub repository, specific branch, and an optional sub-directory (`Sync Path`) for synchronization.
    
- **Comprehensive History Viewers:**
    
    - **GitHub File History:** View detailed commit history for any Markdown file. Browse past revisions, view content, and restore previous states.
        
    - **GitHub Folder History:** Examine commit history for entire folders. See changed files per commit, and view/restore individual files from historical snapshots.
        
- **Context Menu Integration:** Access **File History** and **Folder History** directly from the Obsidian file explorer's right-click menu.
    
- **Customizable Notifications:** Tailor alert detail: 'Quiet', 'Standard', or 'Verbose'.
    

## 📥 Installation

### Via Obsidian Community Plugins (Coming Soon!)

We are working to list SyncMate on Obsidian's Community Plugins browser. Once approved:

1. Launch **Obsidian**.
    
2. Go to **Settings** (gear icon) -> **Community plugins**.
    
3. Disable `Restricted mode` if active.
    
4. Click **Browse**.
    
5. Search for "GitHub SyncMate".
    
6. Click **Install**.
    
7. **Enable** the plugin in the `Community plugins` list after installation.
    

### Manual Installation (For Early Adopters & Advanced Users)

For immediate access or beta testing:

1. Download `main.js`, `manifest.json`, and `styles.css` (if present) from the latest [Releases page](YOUR_GITHUB_REPO_LINK/releases "null").
    
2. Locate your Obsidian vault's plugin directory: `.obsidian/plugins/` (enable "Show hidden files" if needed).
    
3. Create a new subfolder: `.obsidian/plugins/github-syncmate`.
    
4. Copy downloaded files into the `github-syncmate` folder.
    
5. Restart Obsidian (`Ctrl/Cmd + R`).
    
6. Go to **Settings** -> **Community plugins** and activate "GitHub SyncMate".
    

## 🛠️ Configuration Guide

A one-time GitHub connection setup is required in Obsidian's settings.

### Essential Prerequisites

- Active **GitHub account**.
    
- Dedicated **GitHub repository** for Obsidian notes.
    

### Securing Your Connection: GitHub Personal Access Token (PAT)

A PAT securely authenticates SyncMate.

1. Visit GitHub **Settings** -> **Developer settings** -> **Personal access tokens** -> **Tokens (classic)**.
    
2. Click **Generate new token (classic)**.
    
3. Add a descriptive **Note** (e.g., "Obsidian SyncMate Access").
    
4. Set an **Expiration** date for security.
    
5. **Grant necessary scopes:** `repo` for private repositories; `public_repo` for public.
    
6. Click **Generate token**.
    
7. **IMMEDIATELY COPY THE GENERATED TOKEN.** Store it securely; it will not be shown again.
    

### Configuring SyncMate in Obsidian

1. Open **Obsidian Settings** -> **GitHub SyncMate**.
    
2. **GitHub Connection Settings:**
    
    - **GitHub Personal Access Token:** Paste your PAT.
        
    - **Repository Owner:** Your GitHub username or organization.
        
    - **Repository Name:** Your designated GitHub repository name.
        
    - **Branch:** The specific GitHub branch (e.g., `main`).
        
    - **Sync Path:** (Optional) A subfolder in your repository (e.g., `my-notes/daily-journal`). Leave blank for repository root.
        
    - **Test GitHub Connection:** Verify credentials and connectivity.
        
3. **Synchronization Behavior:**
    
    - **Auto Sync:** Enable continuous background sync.
        
    - **Sync Interval:** Set synchronization frequency (in minutes).
        
4. **Conflict Resolution Preferences:**
    
    - **Conflict Resolution Strategy:** Choose default for handling conflicting changes.
        
5. **Notification Preferences:**
    
    - **Notification Verbosity:** Select your desired level of detail.
        

## 💡 How to Use

### On-Demand Synchronization

- Click the **sync icon** (🔄) in Obsidian's left ribbon.
    
- Or, use the Command Palette (`Ctrl/Cmd + P`) and search for "Sync with GitHub".
    

### Automated Sync in Action

With `Auto Sync` enabled, SyncMate runs silently in the background, keeping your vault synced. Monitor activity via the status bar.

### Exploring File History

To view file history:

- Right-click a Markdown file in the File Explorer.
    
- Select "Show GitHub File History".
    
- A modal lists commits; view content or restore past versions.
    

### Exploring Folder History

To view folder history:

- Right-click a folder in the File Explorer.
    
- Select "Show GitHub Folder History".
    
- A modal displays commits affecting files in that folder. View changed files per commit, and view/restore individual files from those states.
    

### Resolving File Conflicts

When a file changes locally and remotely, a conflict occurs.

- If **Conflict Resolution Strategy** is "Ask me each time," a modal appears for side-by-side comparison:
    
    - **Keep Local Version:** Prioritize local changes.
        
    - **Keep Remote Version:** Adopt the GitHub version.
        
    - **Try Auto-Merge:** Attempt a simple line-based merge.
        
- Other strategies resolve conflicts automatically.
    

### Advanced Operations: Force Pull & Force Push

Found in plugin settings under "Advanced Operations." Use with extreme caution.

- **Force Pull from GitHub:** **DANGER ZONE:** Downloads and _**overwrites**_ **all local files** with GitHub versions. **Any unsaved local changes are permanently lost.**
    
- **Force Push to GitHub:** **DANGER ZONE:** Uploads and _**overwrites**_ **all files on GitHub** with your local versions. **Any remote changes (including those by others) are permanently lost.**
    

## ⚠️ Troubleshooting Tips

Common issues and solutions:

- **`Connection failed` / `Invalid GitHub Token`:**
    
    - **Double-check PAT:** Ensure correct copy, no spaces, and `repo`/`public_repo` scope.
        
    - **Confirm Owner/Repo Name:** Ensure exact match (case-sensitive).
        
- **`404 Not Found` (Repository/Branch/File):**
    
    - **Double-check spelling:** Verify `Repository Owner`, `Repository Name`, `Branch`.
        
    - **Verify Sync Path:** Ensure it's correct or blank for root.
        
- **`409 Conflict` during push:**
    
    - Remote file was modified. Consider "Ask me each time" strategy for manual review.
        
- **Files not synchronizing:**
    
    - **Active internet connection?**
        
    - **Correct `Sync Path`?** Are files within it?
        
    - For diagnostics, check Obsidian developer console (`Ctrl+Shift+I` or `Cmd+Option + I`).
        

## 🤝 Community & Support

Your engagement and contributions improve SyncMate!

- **Report Bugs & Suggest Features:** Open an issue on the [GitHub repository](https://github.com/cybawizz/GitHubSyncMate/issues "null").
    
- **Code Contributions:** We welcome pull requests. Fork and contribute!
    
- **Support Development:** If useful, consider supporting development:

  <a href="https://www.buymeacoffee.com/cybawizz" target="_blank">
  <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" width="180" />
</a>   

## 📄 License

This plugin is distributed under the [MIT License](https://github.com/cybawizz/GitHubSyncMate/blob/main/LICENSE "null"). Refer to the `LICENSE` file in the repository for full details.
