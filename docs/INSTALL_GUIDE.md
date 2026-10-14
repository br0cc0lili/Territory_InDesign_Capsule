# Poster Batch Generator: Installation Guide

This guide explains, step by step, how to get the **Poster Batch Generator** panel into Adobe InDesign. You don't need any technical knowledge: just follow the steps in order.

There are **two ways** to install the plugin. Most people only need **Way A**.

| | **Way A: Install the `.ccx` file** | **Way B: Load the plugin folder with the UXP Developer Tool** |
|---|---|---|
| Who it's for | Everyone who just wants to use the plugin | Testers, or anyone told to use "the latest version from GitHub" |
| What you get | A file ending in `.ccx`, e.g. `PosterBatchGenerator_1.0.1.ccx` | The plugin **folder** (downloaded from GitHub) |
| Effort | 2 minutes, done once | About 15 minutes the first time; then 1 minute each time you start InDesign |
| Stays installed after restarting InDesign | Yes | **No**: you click **Load** again each time |

> **Use one way, not both at the same time.** Both ways install the same plugin. If you switch from one to the other, remove the first one before you start (see [Switching between Way A and Way B](#switching-between-way-a-and-way-b)).

---

## Contents

1. [Before you start](#before-you-start)
2. [Way A: Install the .ccx file](#way-a-install-the-ccx-file)
3. [Way B: Load the plugin folder with the UXP Developer Tool](#way-b-load-the-plugin-folder-with-the-uxp-developer-tool)
4. [Open the panel in InDesign](#open-the-panel-in-indesign)
5. [Switching between Way A and Way B](#switching-between-way-a-and-way-b)
6. [Common problems](#common-problems)
7. [Words used in this guide](#words-used-in-this-guide)

---

## Before you start

Check these four things first:

1. **A Mac** with **Adobe InDesign 2023 or newer**.
   *How to check:* open InDesign, click **InDesign** in the top-left menu bar → **About InDesign**. The version number must be **18.0 or higher** (InDesign 2023 = 18, 2024 = 19, 2025 = 20, …).
2. **The Creative Cloud desktop app**, installed and **signed in** with your Adobe account.
   *How to check:* look for the Creative Cloud icon (a red/coloured rounded "cc" shape) in the menu bar at the top right of your screen, or in your **Applications** folder.
3. **The font Audi Type Extended Bold** installed on your Mac. Without it the posters can't be generated. Ask your team lead if you don't have it.
4. **Permission to install software** on your Mac. Way B asks for your Mac password once; if you don't know it or aren't an administrator, ask your IT department.

---

## Way A: Install the .ccx file

You received a file such as **`PosterBatchGenerator_1.0.1.ccx`** (by e-mail, Teams, a shared drive, …).

### Step A1: Save the file

Save the `.ccx` file somewhere easy to find, for example your **Desktop**.

### Step A2: Quit InDesign

If InDesign is open, quit it: **InDesign** menu → **Quit InDesign** (or press **Cmd + Q**). Save your work first.

### Step A3: Double-click the .ccx file

Double-click the file. The **Creative Cloud desktop app** opens automatically and shows an installation window.

> If a different app opens, or nothing happens: right-click the file → **Open With** → **Creative Cloud**.

### Step A4: Confirm the installation

Creative Cloud shows a **warning** that the plugin doesn't come from the Adobe Marketplace (it may be called "Unverified plugin" or "Third-party plugin").

**This is expected.** The plugin was made in-house, so it isn't listed in Adobe's shop. Click **Install** (or **OK** / **Continue**).

### Step A5: Wait for the confirmation

After a few seconds Creative Cloud confirms that **Poster Batch Generator** is installed. You can close the Creative Cloud window.

### Step A6: Open the panel

Start InDesign and open the panel: see [Open the panel in InDesign](#open-the-panel-in-indesign).

**That's it.** The plugin stays installed, also after restarting InDesign or your Mac.

### Updating to a newer version

When you receive a newer file (a higher number, e.g. `…_1.0.2.ccx`): quit InDesign and double-click the new file. Creative Cloud replaces the old version. Your posters and output folders are not affected.

### Removing the plugin

1. Open the **Creative Cloud desktop app**.
2. Go to **Stock & Marketplace** → **Plugins** → **Manage plugins**. (In some Creative Cloud versions this is under **⋯** or **Plugins** in the left sidebar.)
3. Find **Poster Batch Generator**, click **⋯** next to it → **Uninstall**.

---

## Way B: Load the plugin folder with the UXP Developer Tool

Use this way when you were asked to test the **latest version from GitHub**, or when you don't have a `.ccx` file. It takes longer the first time, so set aside about 15 minutes.

You will:

1. Download the plugin folder (B1–B2)
2. Install the **UXP Developer Tool**, Adobe's free tool for loading plugins (B3)
3. Allow it to work on your Mac: "Developer Mode" (B4) and **access to the folder** (B5)
4. Tell it where the plugin is, and load it into InDesign (B6–B8)

> **Already using Way A?** Remove the installed `.ccx` version first (see [Removing the plugin](#removing-the-plugin)).

### Step B1: Download the plugin from GitHub

1. Open the project's GitHub page in your web browser (your team lead will send you the link, e.g. `https://github.com/ziyan-z/Terry_InDesign_Plugin`). You may need to sign in to GitHub.
2. Click the green **Code** button.
3. Click **Download ZIP**.
4. A file such as **`Terry_InDesign_Plugin-main.zip`** is saved, usually in your **Downloads** folder.

### Step B2: Unzip it and put the folder in a good place

1. Double-click the `.zip` file. A folder appears next to it, e.g. **`Terry_InDesign_Plugin-main`**.
2. **Move this folder to a place where it can stay**, because InDesign reads the plugin from it every time. A good place is a new folder called **`Plugins`** inside your **home folder** (the folder with the house icon and your name in Finder):
   1. In Finder, click **Go** → **Home** (or press **Shift + Cmd + H**).
   2. **File** → **New Folder**, name it **`Plugins`**.
   3. Drag the **`Terry_InDesign_Plugin-main`** folder into it.

   > **Why not leave it in Downloads, Documents or Desktop?** macOS protects those folders, so the UXP Developer Tool needs extra permission to read them (Step B5). Your home folder's `Plugins` folder avoids that. If you prefer Documents, that's fine too; just don't skip Step B5.

3. Open the folder and look inside. You should see:

   ```
   Terry_InDesign_Plugin-main/
     docs/
     plugin/          ← this is the plugin
       css/
       icons/
       js/
       index.html
       manifest.json  ← you'll pick this file in Step B6
     README.md
   ```

   Remember where **`plugin/manifest.json`** is. That file is how the tool recognises the plugin.

### Step B3: Install the UXP Developer Tool

1. Open the **Creative Cloud desktop app**.
2. Click **Apps** (left sidebar) → **All apps**.
3. In the search field at the top, type **UXP Developer Tool**.
4. Next to **UXP Developer Tools**, click **Install**. Wait until it's finished.

> If it doesn't appear: in the search results, switch the filter to show **all** apps, or ask IT. Some company accounts hide developer tools.

### Step B4: First start: enable "Developer Mode"

1. **Start InDesign first** and leave it open. (The tool needs InDesign to be running.)
2. Open **UXP Developer Tools**: from Creative Cloud (**Open** next to it), or from **Applications**.
3. The first time, it asks to **Enable Developer Mode**. Click **Enable**.
4. macOS asks for your **Mac password** (the one you use to log in). Type it and confirm. This is needed only once.

You now see the tool's main window. Under **Connected apps** (or similar), **InDesign** should be listed with its version number. If InDesign isn't listed, make sure it's running, then restart the UXP Developer Tool.

### Step B5: Allow access to the plugin folder (important)

macOS doesn't let apps read your **Documents**, **Desktop** and **Downloads** folders until you allow it. If the plugin folder is in one of these, and this permission is missing, you'll get the error:

> *A JavaScript error occurred in the main process. Uncaught Exception: Error: EPERM: operation not permitted, scandir '…/plugin'*

To allow it:

1. Click the **Apple menu** (the apple logo, top left) → **System Settings**.
2. In the left sidebar, click **Privacy & Security**.
3. On the right, click **Files & Folders**.
4. Find **Adobe UXP Developer Tools** (or **UXP Developer Tool**) and click the **›** arrow to expand it.
5. Switch **on** the folder where your plugin is: **Documents Folder**, **Desktop Folder** or **Downloads Folder**.
6. **Quit** the UXP Developer Tool (**Cmd + Q**) and open it again. The new permission only takes effect after a restart.

**If the app isn't listed under Files & Folders**, give it **Full Disk Access** instead:

1. In **Privacy & Security**, click **Full Disk Access**.
2. Click **+** at the bottom of the list, enter your Mac password if asked.
3. Go to **Applications**, select **Adobe UXP Developer Tools** (it may be inside an **Adobe UXP Developer Tools** folder), click **Open**.
4. Make sure its switch is **on**, then quit and reopen the tool.

> Your plugin folder is in your home folder's `Plugins` folder (Step B2)? Then you can usually skip this step. Come back to it only if you see the EPERM error.

### Step B6: Add the plugin to the tool

1. In the UXP Developer Tool, click **Add Plugin** (top right).
2. A file window opens. Go to your plugin folder and open the **`plugin`** folder inside it.
3. Select **`manifest.json`** and click **Select** (or **Open**).
4. A new row appears in the list: **Poster Batch Generator**, with **InDesign** as the app.

You only do this once. The tool remembers the plugin from now on.

### Step B7: Load the plugin into InDesign

1. Make sure **InDesign is open**.
2. In the plugin's row, click **Load**. (If you don't see a Load button, click the **⋯** (Actions) button at the end of the row → **Load**.)
3. After a moment, the row shows that the plugin is **loaded**, and InDesign may open the panel straight away.

### Step B8: Open the panel

If the panel didn't open by itself, see [Open the panel in InDesign](#open-the-panel-in-indesign).

### Every time you start InDesign (Way B only)

A plugin loaded with the UXP Developer Tool is **not** permanently installed. After you quit InDesign, it's gone until you load it again:

1. Start **InDesign**.
2. Open the **UXP Developer Tool**.
3. Click **Load** in the Poster Batch Generator row (the plugin is still in the list; no need to add it again).

### Getting a newer version (Way B)

1. Download the ZIP again (Step B1) and unzip it.
2. Replace the old folder in your `Plugins` folder with the new one (same name, same place).
3. In the UXP Developer Tool, click **⋯** → **Reload** (or **Unload**, then **Load**).

> If you put the new version in a **different** place, remove the old row (**⋯** → **Remove**) and add the new `manifest.json` (Step B6).

### Useful buttons in the UXP Developer Tool

All in the plugin's row, mostly under **⋯** (Actions):

| Button | What it does |
|---|---|
| **Load** | Puts the plugin into InDesign |
| **Reload** | Reloads it after the files changed (e.g. a new version) |
| **Unload** | Takes it out of InDesign again (files stay where they are) |
| **Remove** | Removes the row from the tool's list (files stay where they are) |
| **Package** | Creates a `.ccx` file from the folder (for whoever shares new versions) |
| Watch, Debug | For developers only, not needed |

---

## Open the panel in InDesign

1. In InDesign's menu bar, click **Plugins**.
2. Click **Poster Batch** (it may be inside a **Poster Batch Generator** submenu).

The panel opens. You can drag it by its tab to dock it next to your other panels, like any InDesign panel.

> **No Plugins menu?** In some InDesign versions plugins are under **Window** → **Plugins**, or **Window** → **Utilities**. If you can't find it, restart InDesign once.

When the panel opens, check the top of it:

- **No coloured banner:** everything is fine. Continue with the [User Guide](USER_GUIDE.md).
- **Amber banner "Audi Type font not installed":** install the font, then close and reopen the panel.
- **Red banner "Plugin module load error":** the plugin files are incomplete. Download the plugin again (Way B), or ask for a new `.ccx` (Way A).

---

## Switching between Way A and Way B

Both ways install the **same plugin**, so InDesign can't have both at once.

- **From Way A to Way B:** uninstall the `.ccx` version in Creative Cloud ([Removing the plugin](#removing-the-plugin)), restart InDesign, then follow Way B.
- **From Way B to Way A:** in the UXP Developer Tool, click **⋯** → **Unload**, then **⋯** → **Remove**. Quit InDesign, then follow Way A.

---

## Common problems

| What you see | What to do |
|---|---|
| Double-clicking the `.ccx` does nothing / opens another app | Right-click the file → **Open With** → **Creative Cloud**. Make sure Creative Cloud is installed and you're signed in. |
| Creative Cloud says the plugin can't be installed | Check your InDesign version (18.0 or higher). Make sure InDesign is quit, then try again. |
| *EPERM: operation not permitted, scandir …* | macOS is blocking access to the folder: do [Step B5](#step-b5-allow-access-to-the-plugin-folder-important), then restart the UXP Developer Tool. |
| InDesign isn't listed in the UXP Developer Tool | Start InDesign first, then restart the UXP Developer Tool. |
| **Load** does nothing or shows an error | Make sure InDesign is open and not showing a dialog box. Close dialogs, then click Load again. |
| "A plugin with this ID is already installed/loaded" | The other way is still active. See [Switching between Way A and Way B](#switching-between-way-a-and-way-b). |
| **Add Plugin** won't accept the file | Pick the file **`manifest.json`** inside the **`plugin`** folder, not the outer folder or the ZIP. |
| The panel disappeared after restarting InDesign | Normal with Way B: open the UXP Developer Tool and click **Load** again. |
| The panel opens but says "InDesign isn't responding to the plugin" | Close any open InDesign dialog, then close the panel and open it again from the **Plugins** menu. |
| Can't find the panel | **Plugins** menu → **Poster Batch**. See [Open the panel in InDesign](#open-the-panel-in-indesign). |

**Still stuck?** Send the plugin team a screenshot of the error message and tell them which way (A or B) you used.

---

## Words used in this guide

| Word | Meaning |
|---|---|
| **Plugin** | An add-on that gives InDesign new features, here the Poster Batch panel. |
| **`.ccx` file** | The plugin packed into one file, ready to install with Creative Cloud. |
| **Creative Cloud desktop app** | Adobe's app that installs and updates InDesign and its plugins. |
| **UXP Developer Tool** | Adobe's free tool to load a plugin straight from a folder, without packing it first. |
| **`manifest.json`** | A small file inside the `plugin` folder that describes the plugin. The UXP Developer Tool needs it to recognise the plugin. |
| **GitHub** | The website where the plugin's files are stored and shared by the team. |
| **ZIP file** | A compressed folder. Double-click it to unpack it. |
| **Developer Mode** | A setting that lets the UXP Developer Tool load plugins. Enabled once, with your Mac password. |
| **Files & Folders / Full Disk Access** | macOS privacy settings that decide which apps may read which folders. |
