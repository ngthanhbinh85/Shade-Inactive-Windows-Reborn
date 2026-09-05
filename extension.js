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

        if (actor?.is_in_clone_paint()) {
            actor.continue_paint(paintContext);
            return;
        }

        super.vfunc_paint(node, paintContext, flags);
    }
});

export default class ShadeInactiveWindowsExtension extends Extension {
    enable() {
        this._windows = new Map();
        this._signals = [];
        this._settingsSignals = [];
        this._excludedApps = new Set();
        this._windowTracker = Shell.WindowTracker.get_default();

        this._settings = this.getSettings();
        this._reloadExcludedApps();

        this._settingsSignals.push(
            this._settings.connect('changed::shade-percent', () => this._safeRefresh(true)),
            this._settings.connect('changed::fade-duration', () => this._safeRefresh(true)),
            this._settings.connect('changed::excluded-apps', () => {
                this._reloadExcludedApps();
                this._safeRefresh(true);
            })
        );

        this._connect(global.display, 'notify::focus-window', () => {
            this._safeRefresh();
        });

        // Apply the correct brightness when a new window appears.
        this._connect(global.window_manager, 'map', () => {
            this._safeRefresh();
        });

        // Remove the effect and saved state when a window is closed.
        this._connect(global.window_manager, 'destroy', (_wm, actor) => {
            this._safeForgetActor(actor);
        });

        this._safeRefresh();
    }

    disable() {
        // Stop incoming callbacks before touching actors/effects.
        if (this._settings && this._settingsSignals) {
            for (const id of this._settingsSignals) {
                try {
                    if (id)
                        this._settings.disconnect(id);
                } catch (error) {
                    console.error(`${this.uuid}: failed to disconnect settings signal: ${error}`);
                }
            }
        }
        this._settingsSignals = null;
        this._settings = null;

        if (this._signals) {
            for (const [object, id] of this._signals) {
                try {
                    if (id)
                        object.disconnect(id);
                } catch (error) {
                    console.error(`${this.uuid}: failed to disconnect signal: ${error}`);
                }
            }
        }
        this._signals = null;

        if (this._windows) {
            for (const [actor, state] of [...this._windows])
                this._removeState(actor, state);

            this._windows.clear();
        }
        this._windows = null;

        if (this._excludedApps)
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

    _safeRefresh(force = false) {
        try {
            this._refresh(force);
        } catch (error) {
            console.error(`${this.uuid}: refresh failed: ${error}`);
        }
    }

    _refresh(force = false) {
        if (!this._windows)
            return;

        const liveActors = new Set();
        const focusedWindow = global.display.focus_window;

        for (const actor of global.get_window_actors()) {
            if (!actor)
                continue;

            liveActors.add(actor);

            try {
                const metaWindow = actor.get_meta_window();

                if (!this._shouldShade(metaWindow)) {
                    this._forgetActor(actor);
                    continue;
                }

                const inactive = metaWindow !== focusedWindow;
                this._setActorInactive(actor, inactive, force);
            } catch (error) {
                // Skip a window being created or destroyed without stopping
                // brightness updates for the other windows.
                console.error(`${this.uuid}: skipped a window actor: ${error}`);
                this._safeForgetActor(actor);
            }
        }

        // Defensive cleanup if a destroy signal was missed.
        for (const actor of [...this._windows.keys()]) {
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
        const shadePercent = this._settings.get_int('shade-percent');
        const target = inactive ? -(shadePercent / 100.0) : 0.0;

        // Repeated map/focus notifications with the same destination should
        // not restart the animation. A settings change may deliberately force
        // recalculation even when focus state did not change.
        if (!force && state.target === target)
            return;

        this._animateBrightness(actor, state, target);
    }

    _ensureState(actor) {
        let state = this._windows.get(actor);
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
        };

        this._windows.set(actor, state);
        return state;
    }

    _animateBrightness(actor, state, target) {
        this._stopAnimation(state);

        const [start] = state.effect.get_brightness();

        state.target = target;

        const duration = this._settings.get_int('fade-duration');

        // Keep the offscreen effect out of the focused window's render path
        // whenever it is already fully restored. Duration 0 intentionally
        // applies the new setting immediately without creating a Timeline.
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
            try {
                // Ignore stale callbacks after replacement/cleanup.
                if (!this._windows || this._windows.get(actor) !== state ||
                    state.timeline !== timeline)
                    return;

                const progress = timeline.get_progress();
                const value = start + (target - start) * progress;
                state.effect.set_brightness(value);
            } catch (error) {
                console.error(`${this.uuid}: animation frame failed: ${error}`);
                this._safeForgetActor(actor);
            }
        });

        state.completedSignal = timeline.connect('completed', () => {
            try {
                if (!this._windows || this._windows.get(actor) !== state ||
                    state.timeline !== timeline)
                    return;

                state.effect.set_brightness(target);

                // Once the focused window reaches normal brightness, remove
                // the offscreen effect from the render path entirely.
                if (target === 0.0)
                    state.effect.enabled = false;

                this._clearTimeline(state, timeline);
            } catch (error) {
                console.error(`${this.uuid}: animation completion failed: ${error}`);
                this._safeForgetActor(actor);
            }
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

        // Clear state first so any synchronous signal caused by stop() is
        // recognized as stale.
        if (state.timeline === timeline)
            state.timeline = null;

        try {
            if (state.frameSignal)
                timeline.disconnect(state.frameSignal);
        } catch (_error) {
            // Timeline may already be finalized/stopped.
        }

        try {
            if (state.completedSignal)
                timeline.disconnect(state.completedSignal);
        } catch (_error) {
            // Timeline may already be finalized/stopped.
        }

        state.frameSignal = 0;
        state.completedSignal = 0;

        if (stop) {
            try {
                if (timeline.is_playing())
                    timeline.stop();
            } catch (_error) {
                // Actor/timeline may already be tearing down.
            }
        }
    }

    _safeForgetActor(actor) {
        try {
            this._forgetActor(actor);
        } catch (error) {
            console.error(`${this.uuid}: actor cleanup failed: ${error}`);
        }
    }

    _forgetActor(actor) {
        if (!actor || !this._windows)
            return;

        const state = this._windows.get(actor);
        if (!state)
            return;

        this._removeState(actor, state);
        this._windows.delete(actor);
    }

    _removeState(actor, state) {
        this._stopAnimation(state);

        try {
            state.effect.enabled = false;
            actor.remove_effect(state.effect);
        } catch (error) {
            // The actor may already be in destruction.
            console.error(`${this.uuid}: effect cleanup failed: ${error}`);
        }

        state.effect = null;
        state.target = null;
    }
}
