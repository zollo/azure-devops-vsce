// Connects declarative event attributes to the page's functions, so webviews need no inline
// event handlers and can run under a nonce-only Content-Security-Policy.
//
//   <button data-click="openWorkItem" data-click-args="[42]">       -> openWorkItem(42)
//   <input data-change="handleFilterChange" data-change-args='["state", "$el"]'>
//   <div data-click="toggleColumn" data-click-args='["$parent"]' data-stop>
//
// data-<event> names a global function. data-<event>-args (or data-args, shared by every event
// on the element) is a JSON array of its arguments; these strings stand for
// values from the event: "$el" (the element), "$event", "$checked" (el.checked), "$parent"
// (el.parentElement) and "$column" (the closest .column). data-stop stops the event from
// reaching outer elements, like event.stopPropagation() did in the inline handlers.
//
// Elements added later (menus, re-rendered cards) are connected as they appear.
(function () {
    'use strict';

    var EVENTS = ['click', 'dblclick', 'change', 'input', 'keydown', 'focus', 'blur', 'submit',
        'dragstart', 'dragover', 'dragleave', 'drop', 'dragend', 'contextmenu', 'mousedown'];
    var SELECTOR = EVENTS.map(function (name) { return '[data-' + name + ']'; }).join(',');
    var bound = new WeakMap();

    function resolveArg(arg, el, event) {
        switch (arg) {
            case '$el': return el;
            case '$event': return event;
            case '$checked': return el.checked;
            case '$value': return el.value;
            case '$parent': return el.parentElement;
            case '$column': return el.closest('.column');
            default: return arg;
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
                var fn = window[el.getAttribute('data-' + name)];
                if (typeof fn !== 'function') {
                    console.error('No handler named', fnName);
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

    function start() {
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
