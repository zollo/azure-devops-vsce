// Connects declarative event attributes to the page's functions, so webviews need no inline
// event handlers and can run under a nonce-only Content-Security-Policy.
//
//   <button data-click="openWorkItem" data-click-args="[42]">       -> openWorkItem(42)
//   <input data-change="handleFilterChange" data-change-args='["state", {"$ref": "el"}]'>
//   <div data-click="toggleColumn" data-click-args='[{"$ref": "parent"}]' data-stop>
//
// data-<event> names a global function. data-<event>-args (or data-args, shared by every event
// on the element) is a JSON array of its arguments. Plain values are passed as they are, so
// any string from Azure DevOps arrives unchanged; {"$ref": name} stands for a value from the
// event: "el" (the element), "event", "checked" (el.checked), "value" (el.value), "parent"
// (el.parentElement) or "column" (the closest .column). data-stop stops the event from
// reaching outer elements, like event.stopPropagation() did in the inline handlers.
//
// Elements added later (menus, re-rendered cards) are connected as they appear.
//
// Only functions named in the page as the extension rendered it can be called, plus any a
// script adds with allowWebviewHandlers(names). Markup that arrives later, such as pasted
// rich text, can't name some other global function and have it run.
(function () {
    'use strict';

    var EVENTS = ['click', 'dblclick', 'change', 'input', 'keydown', 'focus', 'blur', 'submit',
        'dragstart', 'dragover', 'dragleave', 'drop', 'dragend', 'contextmenu', 'mousedown'];
    var SELECTOR = EVENTS.map(function (name) { return '[data-' + name + ']'; }).join(',');
    var bound = new WeakMap();
    var allowed = Object.create(null);

    function allow(names) {
        names.forEach(function (name) {
            if (/^[A-Za-z_$][\w$]*$/.test(name)) {
                allowed[name] = true;
            }
        });
    }

    function collectAllowed(root) {
        root.querySelectorAll(SELECTOR).forEach(function (el) {
            EVENTS.forEach(function (name) {
                var fnName = el.getAttribute('data-' + name);
                if (fnName) {
                    allow([fnName]);
                }
            });
        });
    }

    function resolveArg(arg, el, event) {
        if (!arg || typeof arg !== 'object' || Array.isArray(arg) || typeof arg.$ref !== 'string') {
            return arg;
        }
        switch (arg.$ref) {
            case 'el': return el;
            case 'event': return event;
            case 'checked': return el.checked;
            case 'value': return el.value;
            case 'parent': return el.parentElement;
            case 'column': return el.closest('.column');
            default: return undefined;
        }
    }

    function readArgs(el, name) {
        var raw = el.getAttribute('data-' + name + '-args') || el.getAttribute('data-args');
        if (!raw) {
            return [];
        }
        try {
            var parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [parsed];
        } catch (e) {
            console.error('Bad data-args on', el, e);
            return [];
        }
    }

    function bindElement(el) {
        var done = bound.get(el) || {};
        EVENTS.forEach(function (name) {
            var fnName = el.getAttribute('data-' + name);
            if (!fnName || done[name]) {
                return;
            }
            done[name] = true;
            el.addEventListener(name, function (event) {
                if (el.hasAttribute('data-stop')) {
                    event.stopPropagation();
                }
                var current = el.getAttribute('data-' + name);
                var fn = allowed[current] && Object.prototype.hasOwnProperty.call(window, current) ? window[current] : undefined;
                if (typeof fn !== 'function') {
                    console.error('No handler named', current);
                    return;
                }
                var args = readArgs(el, name).map(function (arg) { return resolveArg(arg, el, event); });
                return fn.apply(el, args);
            });
        });
        bound.set(el, done);
    }

    function bindTree(root) {
        if (root.nodeType !== 1) {
            return;
        }
        if (root.matches(SELECTOR)) {
            bindElement(root);
        }
        root.querySelectorAll(SELECTOR).forEach(bindElement);
    }

    window.bindWebviewHandlers = bindTree;
    window.allowWebviewHandlers = allow;

    function start() {
        collectAllowed(document.documentElement);
        bindTree(document.documentElement);
        new MutationObserver(function (mutations) {
            mutations.forEach(function (mutation) {
                if (mutation.type === 'attributes') {
                    bindElement(mutation.target);
                } else {
                    mutation.addedNodes.forEach(bindTree);
                }
            });
        }).observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: EVENTS.map(function (name) { return 'data-' + name; })
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
