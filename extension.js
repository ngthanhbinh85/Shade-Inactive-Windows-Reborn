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
 // 1.0.3 added, for drawing active window shadow 
import Cairo from 'gi://cairo';
import Cogl from 'gi://Cogl';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const EFFECT_NAME = 'shade-inactive-windows-reborn-binhnguyensoft-com';
const SHADE_PROPERTY = `@effects.${EFFECT_NAME}.shade-value`;

// Fix for Fedora Workstation 39: Cogl.Color.from_string is unavailable 
const Color = Cogl.Color?.from_string ? Cogl.Color : Clutter.Color;

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

        this._initShadow(); //

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
        
        //
        this._disconnectShadow();
        if (this._repaintId) {
            this._actorShadow.disconnect(this._repaintId);
            this._repaintId = null;
        }
        this._bindShadowX = this._bindShadowY = null;
        this._actorShadow.destroy();
        this._actorShadow = this._focusActorShadow = this._windowShadow = null;
        this._signalsShadow = this._shadowFrame = this._shadowColor = null;
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

    //
    _initShadow() {
        this._signalsShadow = [];
        this._actorShadow = new St.DrawingArea({reactive: false, can_focus: false, visible: false});
        global.window_group.add_child(this._actorShadow);

        this._bindShadowX = new Clutter.BindConstraint({coordinate: Clutter.BindCoordinate.X});
        this._bindShadowY = new Clutter.BindConstraint({coordinate: Clutter.BindCoordinate.Y});
        this._actorShadow.add_constraint(this._bindShadowX);
        this._actorShadow.add_constraint(this._bindShadowY);

        this._repaintId = this._actorShadow.connect('repaint', () => this._drawShadow());
        
        this._connect(global.display, 'notify::focus-window', () => this._focusShadow());
        this._connect(global.display, 'restacked', () => this._syncShadow());
        this._connect(global.window_manager, 'map', () => this._focusShadow());
        this._connect(global.window_manager, 'switch-workspace', () => this._syncShadow());
        this._connect(Main.overview, 'showing', () => this._syncShadow());
        this._connect(Main.overview, 'hidden', () => this._syncShadow());
        this._connect(Main.sessionMode, 'updated', () => this._syncShadow());
        this._connect(this._settings, 'changed', (_settings, key) => {
            if (key.startsWith('shadow-')) {
                this._readShadowSettings();
                this._syncShadow(true);
                this._actorShadow.queue_repaint();
            }
        });
        this._readShadowSettings();
        this._focusShadow();
    }
    
    _drawShadow() {
        const cr = this._actorShadow.get_context();
        try {
            cr.setOperator(Cairo.Operator.CLEAR);
            cr.paint();
            cr.setOperator(Cairo.Operator.OVER);

            if (!this._shadowFrame)
                return;

            const {width, height} = this._shadowFrame;
            const pad = this._shadowPad;
            const [sw, sh] = this._actorShadow.get_surface_size();

            cr.rectangle(0, 0, sw, sh);
            this._roundedRectShadow(cr, pad, pad, width, height, this._shadowRadius);
            cr.setFillRule(Cairo.FillRule.EVEN_ODD);
            cr.clip();
            cr.setFillRule(Cairo.FillRule.WINDING);

            const scolor = this._shadowColor;
            const swidth = this._shadowWidth;
            
            const steps = Math.min(Math.max(swidth, 8), 24);
            const stepAlpha = (this._shadowOpacity / steps) * 1.5;
            
            for (let i = 0; i < steps; i++) {
                const t = i / steps;
                
                const extent = swidth * t;

                const factor = (1 - t) * (1 - t);
                const currentAlpha = stepAlpha * factor;

                cr.setSourceRGBA(
                    scolor.red / 255, 
                    scolor.green / 255, 
                    scolor.blue / 255, 
                    currentAlpha
                );

                this._roundedRectShadow(
                    cr, 
                    pad - extent, 
                    pad - extent,
                    width + extent * 2, 
                    height + extent * 2, 
                    this._shadowRadius + extent
                );
                cr.fill();
            }
        } finally {
            cr.$dispose();
        }
    }
    
    _roundedRectShadow(cr, x, y, width, height, radius) {
        const r = Math.max(0, Math.min(radius, width / 2, height / 2));
        cr.newSubPath();
        cr.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
        cr.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
        cr.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
        cr.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
        cr.closePath();
    }
    
    _focusShadow() {
        const window = global.display.focus_window;
        const actor = window?.get_compositor_private();
        if (actor && actor === this._focusActorShadow) {
            this._syncShadow();
            return;
        }
        this._disconnectShadow();
        this._windowShadow = window;
        this._focusActorShadow = actor;
        if (actor) {

            this._bindShadowX.set_source(actor);
            this._bindShadowY.set_source(actor);
            this._shadowFrame = null;
            this._connectShadow(window, 'size-changed', () => this._syncShadow(true));
            this._connectShadow(actor, 'notify::width', () => this._syncShadow(true));
            this._connectShadow(actor, 'notify::height', () => this._syncShadow(true));

            for (const signal of ['workspace-changed',
                'notify::minimized', 'notify::fullscreen'])
                this._connectShadow(window, signal, () => this._syncShadow());
            for (const property of ['visible', 'mapped', 'opacity',
                'scale-x', 'scale-y', 'translation-x', 'translation-y'])
                this._connectShadow(actor, `notify::${property}`, () => this._syncShadow());
            this._connectShadow(actor, 'destroy', () => {
                this._disconnectShadow();
                this._focusActorShadow = null;
                this._windowShadow = null;
                this._actorShadow.hide();
            });
        }
        this._syncShadow();
    }

    _syncShadow(updateGeometry = false) {

        if (updateGeometry)
            this._shadowFrame = null;

        const actor = this._focusActorShadow;
        const window = this._windowShadow;
        const parent = actor?.get_parent();
        const types = [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG];
        
        if (!this._shadowEnabled || !window || !parent || parent !== global.window_group ||
            !actor.visible || !actor.mapped || window.minimized || window.is_fullscreen() ||
            (window.maximized_horizontally && window.maximized_vertically) ||
            !window.located_on_workspace(global.workspace_manager.get_active_workspace()) ||
            !types.includes(window.get_window_type()) || Main.overview.visible ||
            Main.sessionMode.isLocked || actor.scale_x !== 1 || actor.scale_y !== 1 ||
            actor.translation_x !== 0 || actor.translation_y !== 0) {
            
            this._actorShadow.hide();
            return;
        }
        parent.set_child_below_sibling(this._actorShadow, actor);

        if (updateGeometry || !this._shadowFrame) {
            const frame = window.get_frame_rect();
            const buffer = window.get_buffer_rect();
            const pad = this._shadowWidth + 2;
            this._shadowFrame = frame;
            this._shadowPad = pad;
            this._bindShadowX.set_offset(frame.x - buffer.x - pad);
            this._bindShadowY.set_offset(frame.y - buffer.y - pad);
            this._actorShadow.set_size(frame.width + pad * 2, frame.height + pad * 2);
        }

        this._actorShadow.opacity = actor.opacity;
        this._actorShadow.show();
    }
    
    _readShadowSettings() {
        this._shadowEnabled = this._settings.get_boolean('shadow-enabled');
        this._shadowWidth = this._settings.get_int('shadow-width');
        this._shadowOpacity = this._settings.get_int('shadow-opacity') / 100;
        this._shadowRadius = this._settings.get_int('shadow-radius');

        const [valid, color] = Color.from_string(this._settings.get_string('shadow-color'));
        if (valid) {
            this._shadowColor = color;
        } else {
            this._shadowColor = Color.from_string('#000000')[1];
        }
    }

    _connectShadow(object, signal, callback) {
        this._signalsShadow.push([object, object.connect(signal, callback)]);
    }

    _disconnectShadow() {
        this._bindShadowX.set_source(null);
        this._bindShadowY.set_source(null);

        for (const [object, id] of this._signalsShadow)
            object.disconnect(id);
        this._signalsShadow.length = 0;
    }

}
