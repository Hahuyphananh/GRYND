/**
 * GRYND Platform SDK v1
 * ---------------------
 *
 * A minimal, dependency-free helper for a platform PAGE that frames a GRYND
 * game. It is NOT authentication: the session token is minted by the platform's
 * own backend (see docs/platform-integration.md) and is already part of the
 * iframe URL. This file contains no secrets and can be served publicly.
 *
 * Security rules enforced here:
 *   - `origin` is REQUIRED and must be an explicit https origin.
 *   - every postMessage uses that origin as targetOrigin; `"*"` is never used.
 *   - inbound messages are accepted only from that exact origin, with the
 *     versioned `{ source: "grynd-platform", version: 1, type }` envelope.
 *
 * Events: grynd:ready, grynd:match_started, grynd:match_finished,
 *         grynd:session_expired, grynd:exit, grynd:error.
 */
(function (global) {
  "use strict";

  var VERSION = 1;
  var SOURCE = "grynd-platform";
  var EVENTS = [
    "grynd:ready",
    "grynd:match_started",
    "grynd:match_finished",
    "grynd:session_expired",
    "grynd:exit",
    "grynd:error",
  ];

  function normalizeOrigin(origin) {
    if (typeof origin !== "string" || !origin) {
      throw new Error("GryndPlatformSDK: an explicit https origin is required");
    }
    var url = new URL(origin);
    if (url.protocol !== "https:") {
      throw new Error("GryndPlatformSDK: origin must be https");
    }
    if (url.username || url.password) {
      throw new Error("GryndPlatformSDK: origin must not contain credentials");
    }
    return url.protocol + "//" + url.host;
  }

  function create(options) {
    if (!options || typeof options !== "object") {
      throw new Error("GryndPlatformSDK: options are required");
    }
    var origin = normalizeOrigin(options.origin);
    var iframe = options.iframe;
    if (!iframe || typeof iframe !== "object") {
      throw new Error("GryndPlatformSDK: an iframe element is required");
    }

    var listeners = {};
    var destroyed = false;

    function emit(type, payload) {
      var handlers = listeners[type] || [];
      for (var i = 0; i < handlers.length; i += 1) {
        try {
          handlers[i](payload);
        } catch (error) {
          // A platform handler must never break message processing.
          if (global.console && global.console.error) {
            global.console.error("[grynd-sdk] handler failed", error);
          }
        }
      }
    }

    function post(type, payload) {
      if (destroyed) return false;
      var win = iframe.contentWindow;
      if (!win) return false;
      var message = { source: SOURCE, version: VERSION, type: type };
      if (payload && typeof payload === "object") {
        for (var key in payload) {
          if (Object.prototype.hasOwnProperty.call(payload, key)) {
            message[key] = payload[key];
          }
        }
      }
      // Explicit target origin, never "*".
      win.postMessage(message, origin);
      return true;
    }

    function onMessage(event) {
      if (!event || event.origin !== origin) return;
      var data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.source !== SOURCE || data.version !== VERSION) return;
      if (typeof data.type !== "string" || EVENTS.indexOf(data.type) === -1) return;
      emit(data.type, data);
    }

    global.addEventListener("message", onMessage);

    return {
      version: VERSION,
      /** Start the practice game (the embed may also auto-start on ready). */
      start: function () {
        return post("grynd:start");
      },
      /** Ask the game to shut down and tell the platform it may close. */
      exit: function () {
        return post("grynd:exit");
      },
      /** Liveness probe; the game answers with grynd:ready. */
      ping: function () {
        return post("grynd:ping");
      },
      on: function (event, handler) {
        if (EVENTS.indexOf(event) === -1 || typeof handler !== "function") return false;
        listeners[event] = listeners[event] || [];
        listeners[event].push(handler);
        return true;
      },
      destroy: function () {
        destroyed = true;
        global.removeEventListener("message", onMessage);
        listeners = {};
      },
    };
  }

  global.GryndPlatformSDK = { version: VERSION, create: create };
})(window);
