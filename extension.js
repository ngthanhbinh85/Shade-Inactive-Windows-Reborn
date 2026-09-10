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

// Prevent window previews from being shaded
const PreviewSafeBrightnessEffect = GObject.registerClass(
class PreviewSafeBrightnessEffect extends Clutter.BrightnessContrastEffect {
    vfunc_paint(node, paintContext, flags) {
        const actor = this.get_actor();

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
        this._excludedApps = new Set();
        this._windowTracker = Shell.WindowTracker.get_default();

        this._settings = this.getSettings();
        this._reloadExcludedApps();

        this._connect(this._settings, 'changed', (_settings, key) => {
            if (key === 'excluded-apps')
                this._reloadExcludedApps();
            this._refresh(true);
        });

        this._connect(global.display, 'notify::focus-window', () => {
            this._refresh();
        });

        // Apply the correct brightness when a new window appears.
        this._connect(global.window_manager, 'map', () => {
            this._refresh();
        });

        // Remove the effect and saved state when a window is closed.
        this._connect(global.window_manager, 'destroy', (_wm, actor) => {
            this._forgetActor(actor);
        });

        this._refresh();
    }

    disable() {
        for (const [object, id] of this._signals)
            object.disconnect(id);

        this._signals = null;
        this._settings = null;

        for (const [actor, state] of this._actors)
            this._removeState(actor, state);

        this._actors.clear();
        this._actors = null;

        this._excludedApps.clear();
        this._excludedApps = null;
        this._windowTracker = null;
    }

    _connect(object, signal, callback) {
        const id = object.connect(signal, callback);
        this._signals.push([object, id]);
    }

    _reloadExcludedApps() {
        this._excludedApps.clear();

        for (const value of this._settings.get_strv('excluded-apps')) {
            const normalized = this._normalizeIdentifier(value);
            if (normalized)
                this._excludedApps.add(normalized);
        }
    }

    _normalizeIdentifier(value) {
        if (typeof value !== 'string')
            return '';

        return value.trim().toLowerCase();
    }

    _refresh(force = false) {
        if (!this._actors)
            return;

        const liveActors = new Set();
        const focusedWindow = global.display.focus_window;

        for (const actor of global.get_window_actors()) {
            if (!actor)
                continue;

            liveActors.add(actor);

            const metaWindow = actor.get_meta_window();

            if (!this._shouldShade(metaWindow)) {
                this._forgetActor(actor);
                continue;
            }

            const inactive = metaWindow !== focusedWindow;
            this._setActorInactive(actor, inactive, force);
        }

        // Remove effects from actors no longer managed by this extension.
        for (const actor of [...this._actors.keys()]) {
            if (!liveActors.has(actor))
                this._forgetActor(actor);
        }
    }

    _shouldShade(metaWindow) {
        if (!metaWindow)
            return false;

        const type = metaWindow.get_window_type();
        if (type !== Meta.WindowType.NORMAL &&
            type !== Meta.WindowType.DIALOG &&
            type !== Meta.WindowType.MODAL_DIALOG)
            return false;

        return !this._isExcluded(metaWindow);
    }

    _isExcluded(metaWindow) {
        if (this._excludedApps.size === 0)
            return false;

        for (const identifier of this._getWindowIdentifiers(metaWindow)) {
            if (this._excludedApps.has(identifier))
                return true;
        }

        return false;
    }

    _getWindowIdentifiers(metaWindow) {
        const identifiers = new Set();

        // Preferred identity: GNOME Shell maps a window to its application
        // (.desktop file id) through WindowTracker.
        const app = this._windowTracker.get_window_app(metaWindow);
        const appId = this._normalizeIdentifier(app?.get_id());
        if (appId)
            identifiers.add(appId);

        const wmClass = this._normalizeIdentifier(metaWindow.get_wm_class());
        if (wmClass)
            identifiers.add(wmClass);

        const wmClassInstance = this._normalizeIdentifier(
            metaWindow.get_wm_class_instance()
        );
        if (wmClassInstance)
            identifiers.add(wmClassInstance);

        return identifiers;
    }

    _setActorInactive(actor, inactive, force = false) {
        const state = this._ensureState(actor);
        const shadePercent = this._settings.get_int('shade-level');
        const target = inactive ? -(shadePercent / 100.0) : 0.0;

        // Skip if the target brightness is unchanged unless an update is forced.
        if (!force && state.target === target)
            return;

        this._animateBrightness(actor, state, target);
    }

    _ensureState(actor) {
        let state = this._actors.get(actor);
        if (state)
            return state;

        const effect = new PreviewSafeBrightnessEffect();
        effect.set_brightness(0.0);
        effect.enabled = false;
        actor.add_effect(effect);

        state = {
            effect,
            timeline: null,
            frameSignal: 0,
            completedSignal: 0,
            target: null,
            destroySignal: actor.connect('destroy', () => this._forgetActor(actor)),
        };

        this._actors.set(actor, state);
        return state;
    }

    _animateBrightness(actor, state, target) {
        this._stopAnimation(state);

        const [start] = state.effect.get_brightness();

        state.target = target;

        const duration = this._settings.get_int('fade-duration');

        // Apply immediately if duration is 0 or brightness already matches
        // Disable the effect at normal brightness to avoid extra rendering
        if (duration === 0 || Math.abs(start - target) < 0.001) {
            state.effect.set_brightness(target);
            state.effect.enabled = target !== 0.0;
            return;
        }

        // The effect must be enabled while fading in either direction.
        state.effect.enabled = true;

        const timeline = Clutter.Timeline.new_for_actor(actor, duration);
        timeline.set_progress_mode(Clutter.AnimationMode.EASE_OUT_QUAD);
        state.timeline = timeline;

        state.frameSignal = timeline.connect('new-frame', () => {
            // Stop updating if the extension, window state, or animation is no longer active.
            if (!this._actors || this._actors.get(actor) !== state || state.timeline !== timeline)
                return;

            const progress = timeline.get_progress();
            const value = start + (target - start) * progress;
            state.effect.set_brightness(value);
        });

        state.completedSignal = timeline.connect('completed', () => {
            if (!this._actors || this._actors.get(actor) !== state ||
                state.timeline !== timeline)
                return;

            state.effect.set_brightness(target);

            // Disable the effect once normal brightness is restored
            if (target === 0.0)
                state.effect.enabled = false;

            this._clearTimeline(state, timeline);
        });

        timeline.start();
    }

    _stopAnimation(state) {
        const timeline = state.timeline;
        if (!timeline)
            return;

        this._clearTimeline(state, timeline, true);
    }

    _clearTimeline(state, timeline, stop = false) {
        if (!timeline)
            return;

        if (state.timeline === timeline)
            state.timeline = null;

        if (state.frameSignal)
            timeline.disconnect(state.frameSignal);

        if (state.completedSignal)
            timeline.disconnect(state.completedSignal);

        state.frameSignal = 0;
        state.completedSignal = 0;

        if (stop && timeline.is_playing())
            timeline.stop();
    }

    _forgetActor(actor) {
        if (!actor || !this._actors)
            return;

        const state = this._actors.get(actor);
        if (!state)
            return;

        this._removeState(actor, state);
        this._actors.delete(actor);
    }

    _removeState(actor, state) {
        this._stopAnimation(state);
        actor.disconnect(state.destroySignal);

        state.effect.enabled = false;
        actor.remove_effect(state.effect);

        state.effect = null;
        state.target = null;
    }
}
