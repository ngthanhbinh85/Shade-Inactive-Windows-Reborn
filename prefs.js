/*
 * Shade Inactive Windows Reborn
 *
 * Copyright (C) 2026 Binh Nguyen (binhnguyensoft.com)
 *
 * Based on the concept of "Shade Inactive Windows"
 * Originally created by hepaajan (https://github.com/hepaajan/shade-inactive-windows)
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 3 of the License, or
 * (at your option) any later version.
 */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ShadeInactiveWindowsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(800, -1);
        this._settings = this.getSettings();
        this._excludedGroup = null;
        this._appEntries = this._getInstalledApps();

        const page = new Adw.PreferencesPage({
            title: 'Shade Inactive Windows Reborn',
            icon_name: 'preferences-desktop-display-symbolic',
        });

        // Shading
        const shadingGroup = new Adw.PreferencesGroup({
            title: 'Shading',
            description: 'Adjust how inactive windows are shaded.',
        });

        const shadeAdjustment = new Gtk.Adjustment({
            lower: 10,
            upper: 80,
            step_increment: 5,
            value: this._settings.get_int('shade-percent'),
        });

        const shadeRow = new Adw.SpinRow({
            title: 'Shade level',
            subtitle: 'Brightness reduction in percent (10 = slightly dark, 80 = very dark).',
            adjustment: shadeAdjustment,
            digits: 0,
            numeric: true,
            snap_to_ticks: true,
        });

        shadeRow.connect('notify::value', row => {
            const value = Math.round(row.get_value());
            if (this._settings.get_int('shade-percent') !== value)
                this._settings.set_int('shade-percent', value);
        });

        const fadeAdjustment = new Gtk.Adjustment({
            lower: 0,
            upper: 1000,
            step_increment: 100,
            value: this._settings.get_int('fade-duration'),
        });

        const fadeRow = new Adw.SpinRow({
            title: 'Fade duration',
            subtitle: 'Transition time in milliseconds (0 = instant)',
            adjustment: fadeAdjustment,
            digits: 0,
            numeric: true,
            snap_to_ticks: true,
        });

        fadeRow.connect('notify::value', row => {
            const value = Math.round(row.get_value());
            if (this._settings.get_int('fade-duration') !== value)
                this._settings.set_int('fade-duration', value);
        });

        shadingGroup.add(shadeRow);
        shadingGroup.add(fadeRow);
        page.add(shadingGroup);

        // Excluded apps
        const exclusionsGroup = new Adw.PreferencesGroup({
            title: 'Excluded apps',
            description: 'These apps remain at normal brightness even when inactive. Useful for media players, image viewers, or reference documents.',
        });
        this._excludedGroup = exclusionsGroup;

        if (this._appEntries.length > 0) {
        
            const appLabels = this._appEntries.map(
                entry => `${entry.name} — ${entry.id}`
            );

            const appModel = Gtk.StringList.new(appLabels);

            const appRow = new Adw.PreferencesRow({
                activatable: false,
                selectable: false,
            });

            const appBox = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 8,
                margin_top: 10,
                margin_bottom: 10,
                margin_start: 12,
                margin_end: 12,
            });

            const titleLabel = new Gtk.Label({
                label: 'Installed apps',
                xalign: 0,
            });
            titleLabel.add_css_class('heading');

            const subtitleLabel = new Gtk.Label({
                label: 'Choose an app, then add it to the exclusion list.',
                xalign: 0,
            });

            const controlsBox = new Gtk.Box({
                spacing: 6,
            });
            
            const appSearchExpression = Gtk.PropertyExpression.new(
                Gtk.StringObject,
                null,
                'string'
            );

            const appDropDown = new Gtk.DropDown({
                model: appModel,
                expression: appSearchExpression,
                enable_search: true,
                search_match_mode: Gtk.StringFilterMatchMode.SUBSTRING,
                hexpand: true,
            });

            const addButton = new Gtk.Button({
                icon_name: 'list-add-symbolic',
                tooltip_text: 'Add selected app',
                valign: Gtk.Align.CENTER,
            });
            addButton.add_css_class('flat');

            controlsBox.append(appDropDown);
            controlsBox.append(addButton);

            appBox.append(titleLabel);
            appBox.append(subtitleLabel);
            appBox.append(controlsBox);

            appRow.set_child(appBox);

            addButton.connect('clicked', () => {
                const index = appDropDown.get_selected();

                if (index >= this._appEntries.length)
                    return;

                this._addExcludedIdentifier(this._appEntries[index].id);
            });

            exclusionsGroup.add(appRow);
        }

        // Fallback for apps whose desktop ID GNOME Shell cannot resolve.
        const customRow = new Adw.ActionRow({
            title: 'Custom app ID/WM_CLASS',
            subtitle: 'Enter an identifier for AppImage, Wine, XWayland, or other unlisted apps.',
        });

        const customEntry = new Gtk.Entry({
            placeholder_text: 'example.desktop or WM_CLASS',
            hexpand: true,
            valign: Gtk.Align.CENTER,
            width_chars: 24,
        });

        const helpButton = new Gtk.Button({
            label: '?',
            tooltip_text: 'How to find an app ID or WM_CLASS',
            valign: Gtk.Align.CENTER,
        });
        helpButton.add_css_class('flat');
        helpButton.add_css_class('circular');

        helpButton.connect('clicked', () => {
            const dialog = new Adw.MessageDialog({
                transient_for: window,
                modal: true,
                heading: 'Finding an app ID or WM_CLASS',
                body:
                    'Desktop app ID: Use the app’s .desktop filename. ' +
                    'You can find it in:\n' +
                    '   • /usr/share/applications\n' +
                    '   • ~/.local/share/applications\n\n' +
                    '   Example: org.mozilla.firefox.desktop\n\n' +
                    'WM_CLASS on X11 or XWayland: Run “xprop WM_CLASS” in Terminal, then click the target window.\n\n' +
                    'Wayland: Press Alt+F2, enter “lg”, open the Windows section, and find the app ID or WM_CLASS.',
            });

            dialog.add_response('close', 'Close');
            dialog.set_default_response('close');
            dialog.set_close_response('close');
            dialog.present();
        });

        const customAddButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: 'Add custom identifier',
            valign: Gtk.Align.CENTER,
        });
        customAddButton.add_css_class('flat');

        customRow.add_suffix(helpButton);
        customRow.add_suffix(customEntry);
        customRow.add_suffix(customAddButton);

        const addCustom = () => {
            const value = customEntry.get_text().trim();
            if (!value)
                return;

            this._addExcludedIdentifier(value);
            customEntry.set_text('');
        };

        customEntry.connect('activate', addCustom);
        customAddButton.connect('clicked', addCustom);

        exclusionsGroup.add(customRow);

        this._renderExcludedRows();
        page.add(exclusionsGroup);
        window.add(page);
        this._addAboutButton(window);

        // Keep the list synchronized if GSettings is changed externally.
        this._settingsChangedId = this._settings.connect('changed::excluded-apps', () => {
            this._renderExcludedRows();
        });

        window.connect('close-request', () => {
            if (this._settingsChangedId) {
                this._settings.disconnect(this._settingsChangedId);
                this._settingsChangedId = 0;
            }
            return false;
        });
    }

    _addAboutButton(window) {
        const headerBar = this._findHeaderBar(window);
        if (!headerBar)
            return;

        const aboutButton = new Gtk.Button({
            icon_name: 'open-menu-symbolic',
            tooltip_text: 'About',
            valign: Gtk.Align.CENTER,
        });
        aboutButton.add_css_class('flat');
        aboutButton.connect('clicked', () => this._showAbout(window));

        headerBar.pack_end(aboutButton);
    }

    _findHeaderBar(widget) {
        if (widget instanceof Adw.HeaderBar)
            return widget;

        for (let child = widget.get_first_child(); child;
            child = child.get_next_sibling()) {
            const headerBar = this._findHeaderBar(child);
            if (headerBar)
                return headerBar;
        }

        return null;
    }

    _showAbout(window) {
        const params = {
            application_name: this.metadata.name,
            developer_name: 'Binh Nguyen',
            version: this.metadata['version-name'],
            comments: 'Rewritten and modernized version inspired by the original Shade Inactive Windows extension by hepaajan.',
            website: this.metadata.url,
            issue_url: `${this.metadata.url}/issues`,
        };


        if (Adw.AboutDialog) {
            const about = new Adw.AboutDialog(params);
            about.add_link(
                'Developer website',
                'https://www.binhnguyensoft.com'
            );
            about.add_link(
                'Original project',
                'https://github.com/hepaajan/shade-inactive-windows'
            );
            about.present(window);
        } else {
            const about = new Adw.AboutWindow({
                ...params,
                transient_for: window,
                modal: true,
            });
            about.add_link(
                'Developer website',
                'https://www.binhnguyensoft.com'
            );
            about.add_link(
                'Original project',
                'https://github.com/hepaajan/shade-inactive-windows'
            );
            about.present();
        }
        
    }

    _getInstalledApps() {
        const apps = [];
        const seen = new Set();

        for (const appInfo of Gio.AppInfo.get_all()) {
            const id = appInfo.get_id();
            if (!id || seen.has(id) || !appInfo.should_show())
                continue;

            const name = appInfo.get_display_name() || appInfo.get_name() || id;
            seen.add(id);
            apps.push({id, name});
        }

        apps.sort((a, b) => a.name.localeCompare(b.name));
        return apps;
    }

    _normalizeIdentifier(value) {
        return value.trim();
    }

    _getExcludedIdentifiers() {
        const result = [];
        const seen = new Set();

        for (const value of this._settings.get_strv('excluded-apps')) {
            const normalized = this._normalizeIdentifier(value);
            const key = normalized.toLowerCase();
            if (!normalized || seen.has(key))
                continue;

            seen.add(key);
            result.push(normalized);
        }

        return result;
    }

    _addExcludedIdentifier(value) {
        const identifier = this._normalizeIdentifier(value);
        if (!identifier)
            return;

        const values = this._getExcludedIdentifiers();
        const key = identifier.toLowerCase();
        if (values.some(item => item.toLowerCase() === key))
            return;

        values.push(identifier);
        values.sort((a, b) => a.localeCompare(b));
        this._settings.set_strv('excluded-apps', values);
    }

    _removeExcludedIdentifier(value) {
        const key = value.toLowerCase();
        const values = this._getExcludedIdentifiers().filter(item => item.toLowerCase() !== key);
        this._settings.set_strv('excluded-apps', values);
    }

    // Resolves an excluded app ID to a display name, falling back to the ID
    // Called by _renderExcludedRows() when displaying excluded apps.
    _getFriendlyName(identifier) {
        const info = Gio.DesktopAppInfo.new(identifier);
        if (info)
            return info.get_display_name() || info.get_name() || identifier;

        const key = identifier.toLowerCase();
        const match = this._appEntries.find(entry => entry.id.toLowerCase() === key);
        return match?.name || identifier;
    }

    _renderExcludedRows() {
        if (!this._excludedGroup)
            return;

        if (this._renderedRows) {
            for (const row of this._renderedRows)
                this._excludedGroup.remove(row);
        }

        this._renderedRows = [];

        for (const identifier of this._getExcludedIdentifiers()) {
            const friendlyName = this._getFriendlyName(identifier);
            const row = new Adw.ActionRow({
                title: friendlyName,
                subtitle: friendlyName === identifier ? 'Custom identifier' : identifier,
            });

            const removeButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: 'Remove from exclusions',
                valign: Gtk.Align.CENTER,
            });
            removeButton.add_css_class('flat');
            removeButton.connect('clicked', () => this._removeExcludedIdentifier(identifier));

            row.add_suffix(removeButton);
            row.activatable_widget = removeButton;
            this._excludedGroup.add(row);
            this._renderedRows.push(row);
        }
    }
}
