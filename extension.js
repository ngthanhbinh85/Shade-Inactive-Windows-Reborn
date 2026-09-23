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

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import GObject from 'gi://GObject';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const EFFECT_NAME = 'shade-inactive-windows-reborn-binhnguyensoft-com';
const SHADE_PROPERTY = `@effects.${EFFECT_NAME}.shade-value`;

const PreviewSafeBrightnessEffect = GObject.registerClass({
    Properties: {
        'shade-value': GObject.ParamSpec.double(
            'shade-value', null, null,
            GObject.ParamFlags.READWRITE, -1, 1, 0),
    },
}, 
class PreviewSafeBrightnessEffect extends Clutter.BrightnessContrastEffect {
    get shade_value() {
        return this._shadeValue ?? 0;
    }

    set shade_value(value) {
        this._shadeValue = value;
        this.set_brightness(value);
    }

    vfunc_paint(node, paintContext, flags) {
        const actor = this.get_actor();
        // Prevent window previews from being shaded
        if (actor.is_in_clone_paint()) {
            actor.continue_paint(paintContext);
            return;
        }
        super.vfunc_paint(node, paintContext, flags);
    }
});

export default class ShadeInactiveWindowsExtension extends Extension {
    enable() {
        this._actors = new Map();
        this._signals = [];
        this._focusedActor = null;
        this._windowTracker = Shell.WindowTracker.get_default();
        this._settings = this.getSettings();
        this._reloadSettings();

        this._connect(this._settings, 'changed', (_settings, key) => {
            if (key === 'fade-duration') {
                this._duration = this._settings.get_int('fade-duration');
                return;
            }

            this._reloadSettings();
            this._refresh();
        });
        this._connect(global.display, 'notify::focus-window', () => {
            const previous = this._focusedActor;
            this._focusedActor = null;
            if (previous)
                this._updateActor(previous);
            const current = global.display.focus_window?.get_compositor_private();
            if (current)
                this._updateActor(current);
        });
        this._connect(global.window_manager, 'map', (_wm, actor) => {
            this._updateActor(actor);
        });
        this._refresh();
    }

    disable() {
        for (const [object, id] of this._signals)
            object.disconnect(id);
        for (const actor of this._actors.keys())
            this._forgetActor(actor);

        this._signals = null;
        this._actors = null;
        this._focusedActor = null;
        this._settings = null;
        this._windowTracker = null;
        this._excludedApps = null;
    }

    _connect(object, signal, callback) {
        this._signals.push([object, object.connect(signal, callback)]);
    }

    _reloadSettings() {
        this._shade = -this._settings.get_int('shade-level') / 100;
        this._duration = this._settings.get_int('fade-duration');
        this._excludedApps = new Set(this._settings.get_strv('excluded-apps').map(id => id.trim().toLowerCase()).filter(Boolean));
    }

    _refresh() {
        this._focusedActor = null;
        for (const actor of global.get_window_actors())
            this._updateActor(actor);
    }

    _shouldShade(window) {
        if (!window)
            return false;
        const type = window.get_window_type();
        if (type !== Meta.WindowType.NORMAL &&
            type !== Meta.WindowType.DIALOG &&
            type !== Meta.WindowType.MODAL_DIALOG)
            return false;
        if (this._excludedApps.size === 0)
            return true;

        const app = this._windowTracker.get_window_app(window);
        return ![app?.get_id(), window.get_wm_class(), window.get_wm_class_instance()]
            .some(id => id && this._excludedApps.has(id.trim().toLowerCase()));
    }

    _updateActor(actor) {
        const window = actor.get_meta_window();
        if (!this._shouldShade(window)) {
            this._forgetActor(actor);
            return;
        }
        const focused = window === global.display.focus_window;
        if (focused)
            this._focusedActor = actor;
        const target = focused ? 0 : this._shade;
        let state = this._actors.get(actor);
        if (!state) {
            const effect = new PreviewSafeBrightnessEffect({enabled: false});
            actor.add_effect_with_name(EFFECT_NAME, effect);
            state = {
                effect,
                target: null,
                destroyId: actor.connect('destroy', () => this._forgetActor(actor)),
            };
            this._actors.set(actor, state);
        }
        if (state.target === target)
            return;
        state.target = target;

        const effect = state.effect;
        
        effect.enabled = true;
        actor.ease_property(SHADE_PROPERTY, target, {
            duration: this._duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                effect.enabled = target !== 0;
            },
        });
    }

    _forgetActor(actor) {
        if (this._focusedActor === actor)
            this._focusedActor = null;
        const state = this._actors?.get(actor);
        if (!state)
            return;
        this._actors.delete(actor);
        actor.disconnect(state.destroyId);
        actor.remove_transition(SHADE_PROPERTY);
        state.effect.enabled = false;
        actor.remove_effect(state.effect);
    }
}

