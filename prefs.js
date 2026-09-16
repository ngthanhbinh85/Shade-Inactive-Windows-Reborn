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
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango'; // for shorten long app name

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// For Excluded apps
const AppItemForExclusion = GObject.registerClass({
    Properties: {
        name: GObject.ParamSpec.string('name', null, null, GObject.ParamFlags.READWRITE, ''),
    },
}, class AppItemForExclusion extends GObject.Object {
    _init(info) {
        super._init({name: info.get_display_name() || info.get_name()});
        this.id = info.get_id();
        this.icon = info.get_icon();
    }
});

export default class ShadeInactiveWindowsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(700, 700);
        this._settings = this.getSettings();
        this._renderedExcludedApps = [];
        this._installedApps = this._getInstalledApps();

        const page = new Adw.PreferencesPage();

        // Shading
        const shadingGroup = new Adw.PreferencesGroup({
            title: 'Shading',
            description: 'Adjust how inactive windows are shaded.',
        });
        
        // Shade level
        // Title & subtitle get from schemas
        const shadingKey = this._settings.settings_schema.get_key('shade-level');

        const shadeAdjustment = new Gtk.Adjustment({
            lower: 10,
            upper: 80,
            step_increment: 5,
        });

        const shadeRow = new Adw.SpinRow({
            title: shadingKey.get_summary(),
            subtitle: shadingKey.get_description(),
            adjustment: shadeAdjustment,
            digits: 0,
            numeric: true,
            snap_to_ticks: true,
        });

        this._settings.bind('shade-level', shadeAdjustment, 'value', Gio.SettingsBindFlags.DEFAULT);

        // Fade Duration
        // Title & subtitle get from schemas
        const fadeKey = this._settings.settings_schema.get_key('fade-duration');
        
        const fadeAdjustment = new Gtk.Adjustment({
            lower: 0,
            upper: 1000,
            step_increment: 100,
        });

        const fadeRow = new Adw.SpinRow({
            title: fadeKey.get_summary(),
            subtitle: fadeKey.get_description(),
            adjustment: fadeAdjustment,
            digits: 0,
            numeric: true,
            snap_to_ticks: true,
        });

        this._settings.bind('fade-duration', fadeAdjustment, 'value', Gio.SettingsBindFlags.DEFAULT);

        shadingGroup.add(shadeRow);
        shadingGroup.add(fadeRow);
        page.add(shadingGroup);

        // Excluded apps
        const exclusionsGroup = new Adw.PreferencesGroup({
            title: this._settings.settings_schema.get_key('excluded-apps').get_summary(),
            description: 'These apps remain at normal brightness even when inactive. Useful for media players, image viewers, or reference documents.',
        });
        this._excludedGroup = exclusionsGroup;

        // List installed apps in a dropdown (icons and names only)
        if (this._installedApps.length > 0) {
        
            const model = new Gio.ListStore({item_type: AppItemForExclusion});
            for (const entry of this._installedApps)
                model.append(entry);

            const appDropDown = new Gtk.DropDown({
                model: model,
                expression: Gtk.PropertyExpression.new(AppItemForExclusion, null, 'name'),
                factory: this._createAppFactory(),
                list_factory: this._createAppFactory(),
                enable_search: true,
                valign: Gtk.Align.CENTER,
                width_request: 300,
                hexpand: false,
                halign: Gtk.Align.END,
            });

            const addButton = new Gtk.Button({
                icon_name: 'list-add-symbolic',
                tooltip_text: 'Add selected app',
                valign: Gtk.Align.CENTER,
            });
            addButton.connect('clicked', () => {
                const entry = appDropDown.get_selected_item();
                if (entry)
                    this._addExcludedIdentifier(entry.id);
            });

            const appRow = new Adw.ActionRow({title: 'Installed apps'});
            appRow.add_suffix(appDropDown);
            appRow.add_suffix(addButton);
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
        helpButton.add_css_class('circular');

        helpButton.connect('clicked', () => {
            const dialog = new Adw.MessageDialog({
                transient_for: window,
                modal: true,
                heading: 'Finding an app ID or WM_CLASS',
                extra_child: new Gtk.Label({
                    xalign: 0,
                    justify: Gtk.Justification.LEFT,
                    wrap: true,
                    selectable: true,
                    label:
                        'Desktop app ID: Use the app’s .desktop filename. ' +
                        'You can find it in:\n\n' +
                        '   ~/.local/share/applications\n' +
                        '   /usr/share/applications\n\n' +
                        '   Example: org.mozilla.firefox.desktop\n\n' +
                        'WM_CLASS on X11 or XWayland: Run “xprop WM_CLASS” in Terminal, then click the target window.\n\n' +
                        'Wayland: Press Alt+F2, enter “lg”, open the Windows section, and find the app ID or WM_CLASS.',
                }),
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
        
        // Keep the list synchronized if GSettings is changed externally.
        this._settingsChangedId = this._settings.connect('changed::excluded-apps', () => {
            this._renderExcludedRows();
        });
        
        // About
        const aboutGroup = new Adw.PreferencesGroup();
        const aboutRow = new Adw.ActionRow({title: 'About', activatable: true});
        aboutRow.add_suffix(new Gtk.Image({icon_name: 'help-about-symbolic'}));
        aboutRow.connect('activated', () => this._showAbout(window));
        aboutGroup.add(aboutRow);
        page.add(aboutGroup);

        window.connect('close-request', () => {
            if (this._settingsChangedId) {
                this._settings.disconnect(this._settingsChangedId);
                this._settingsChangedId = 0;
            }
            return false;
        });

    }

    _createAppFactory() {
        const factory = new Gtk.SignalListItemFactory();
        factory.connect('setup', (_factory, item) => {
            const box = new Gtk.Box({spacing: 8});
            box.append(new Gtk.Image({pixel_size: 24}));
            box.append(new Gtk.Label({
                xalign: 0,
                hexpand: true,
                ellipsize: Pango.EllipsizeMode.END, // shorten text
                max_width_chars: 24,
            }));
            item.set_child(box);
        });
        factory.connect('bind', (_factory, item) => {
            const entry = item.get_item();
            const box = item.get_child();
            box.get_first_child().set_from_gicon(
                entry.icon ?? new Gio.ThemedIcon({name: 'application-x-executable'}));
            box.get_last_child().set_label(entry.name);
        });
        return factory;
    }

    _showAbout(window) {
        const about = new Adw.AboutWindow({
            application_name: this.metadata.name,
            developer_name: 'Binh Nguyen',
            version: this.metadata['version-name'],
            comments: 'Inspired by Shade Inactive Windows by hepaajan.',
            website: this.metadata.url,
            issue_url: `${this.metadata.url}/issues`,
            transient_for: window,
            modal: true,
        });
        about.add_link('Developer website', 'https://www.binhnguyensoft.com');
        about.add_link('Original project', 'https://github.com/hepaajan/shade-inactive-windows');
        about.present();
    }

    _getInstalledApps() {
        const apps = [];
        const seen = new Set();

        for (const appInfo of Gio.AppInfo.get_all()) {
            const id = appInfo.get_id();
            if (!id || seen.has(id) || !appInfo.should_show())
                continue;

            seen.add(id);
            apps.push(new AppItemForExclusion(appInfo));
        }

        apps.sort((a, b) => a.name.localeCompare(b.name));
        return apps;
    }

    _getExcludedIdentifiers() {
        const result = [];
        const seen = new Set();

        for (const value of this._settings.get_strv('excluded-apps')) {
            const normalized = value.trim();
            const key = normalized.toLowerCase();
            if (!normalized || seen.has(key))
                continue;

            seen.add(key);
            result.push(normalized);
        }

        return result;
    }

    _addExcludedIdentifier(value) {
        const identifier = value.trim();
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

    _getAppDetails(identifier) {
        const match = this._installedApps.find(entry =>
            entry.id.toLowerCase() === identifier.toLowerCase());
        if (match)
            return match;

        const info = Gio.DesktopAppInfo.new(identifier);
        return info ? new AppItemForExclusion(info) : {
            name: identifier.replace(/\.desktop$/i, ''),
            icon: null,
        };
    }

    _renderExcludedRows() {
        for (const row of this._renderedExcludedApps)
            this._excludedGroup.remove(row);

        this._renderedExcludedApps = [];

        for (const identifier of this._getExcludedIdentifiers()) {
            const app = this._getAppDetails(identifier);
            const row = new Adw.ActionRow({
                title: app.name,
                use_markup: false,
            });

            const removeButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: 'Remove from exclusions',
                valign: Gtk.Align.CENTER,
            });
            removeButton.connect('clicked', () => this._removeExcludedIdentifier(identifier));

            row.add_prefix(new Gtk.Image({
                gicon: app.icon ?? new Gio.ThemedIcon({name: 'application-x-executable'}),
                pixel_size: 24,
            }));
            row.add_suffix(removeButton);
            row.activatable_widget = removeButton;
            this._excludedGroup.add(row);
            this._renderedExcludedApps.push(row);
        }
    }
}
