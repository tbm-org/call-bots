/* Vendored from ../rtc-stream-monitor (src/rtc-stream-monitor.js), v1.6.6.
 * Do not edit here — update the sibling repo, then re-copy this file.
 * Evaluated as a raw string into each bot's call page after it reaches the
 * call (late injection: the IIFE below appends its panel host at import time,
 * so it must not run at document_start). src/rtc.mjs owns install and readout.
 */
/*!
 * RTC Stream Monitor — live audio/video stream inspector overlay
 * Zero dependencies. Shadow-DOM isolated. Works on compatible WebRTC pages.
 * Google Meet requires the extension's persistent debugger capture path.
 * Re-running the script toggles the panel; window.__rtcStreamMonitor__.stop() removes it.
 */
(function () {
  'use strict';

  var NS = '__rtcStreamMonitor__';
  if (window[NS]) { window[NS].toggle(); return; }

  /* ------------------------------------------------------------------ *
   * Palette — dark steps on surface #1a1a19.
   * Categorical slot 1 (blue) = incoming, slot 2 (orange) = outgoing.
   * Status tokens are reserved and always ship with an icon + label.
   * ------------------------------------------------------------------ */
  var C = {
    surface: '#1a1a19', plane: '#0d0d0d',
    ink: '#ffffff', ink2: '#c3c2b7', muted: '#898781',
    grid: '#2c2c2a', axis: '#383835', border: 'rgba(255,255,255,0.10)',
    inb: '#3987e5', out: '#d95926',
    good: '#0ca30c', warn: '#fab219', crit: '#d03b3b',
    track: '#0d366b'
  };

  var NativeRTCPC = window.RTCPeerConnection;
  var NativeWebkitPC = window.webkitRTCPeerConnection;
  var NativePC = NativeRTCPC || NativeWebkitPC;
  if (!NativePC) { console.warn('[RTC Monitor] No RTCPeerConnection on this page.'); return; }

  /* ================================================================== *
   * 1 — PEER CONNECTION CAPTURE
   * ================================================================== */
  var PCS = [], PCSEEN = new WeakSet(), PATCHED_PROTO = [], NEXT_PC_KEY = 1;
  var EARLY_CAPTURE_KEY = '__rtcStreamMonitorEarlyCapture__';
  var EARLY_CAPTURE_EVENT = 'rtc-stream-monitor:peerconnection';
  var IS_ZOOM_WEBCLIENT_REALM = (function () {
    try {
      if (location.protocol !== 'https:' ||
          !/(^|\.)zoom\.(?:us|com)$/i.test(location.hostname)) return false;
      if (location.pathname === '/wc' ||
          location.pathname.indexOf('/wc/') === 0) return true;
      return /^\/\d+\/(?:start|join)\/?$/.test(location.pathname) &&
        new URLSearchParams(location.search).get('from') === 'pwa';
    } catch (e) { return false; }
  })();

  function register(pc) {
    if (!pc || PCSEEN.has(pc)) return false;
    PCSEEN.add(pc);
    PCS.push({ pc: pc, key: NEXT_PC_KEY++, prev: new Map(), t: 0 });
    if (zoomWaiting) wakeForCapturedConnection();
    return true;
  }

  /* Zoom creates its media connection in a same-origin child web-client frame.
     A tiny document-start shim captures that connection before this larger UI
     script is injected. Drain its backlog, then subscribe so a connection made
     during Zoom's preview screen wakes the hidden monitor immediately. On all
     other sites the key is absent and these two operations are inert. */
  function onEarlyCapturedConnection(event) {
    try {
      var pc = event && event.detail;
      if (pc && typeof pc.getStats === 'function') register(pc);
    } catch (e) {}
  }
  var earlyCaptureListening = false;
  try {
    var earlyCapture = IS_ZOOM_WEBCLIENT_REALM ? window[EARLY_CAPTURE_KEY] : null;
    if (earlyCapture && Array.isArray(earlyCapture.connections)) {
      window.addEventListener(EARLY_CAPTURE_EVENT, onEarlyCapturedConnection);
      earlyCaptureListening = true;
      earlyCapture.connections.forEach(function (pc) {
        if (pc && typeof pc.getStats === 'function') register(pc);
      });
    }
  } catch (e) {}

  /* (a) future connections */
  function WrappedPC() {
    var pc = new (Function.prototype.bind.apply(NativePC, [null].concat([].slice.call(arguments))))();
    register(pc);
    return pc;
  }
  WrappedPC.prototype = NativePC.prototype;
  try { Object.setPrototypeOf(WrappedPC, NativePC); } catch (e) {}
  try {
    window.RTCPeerConnection = WrappedPC;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = WrappedPC;
  } catch (e) {}

  /* (b) live connections — captured the moment the app touches them.
     Every hook is attempted individually and may fail without consequence.
     Google Meet ships a hardened RTCPeerConnection prototype whose methods are
     non-writable: a plain `proto[m] = ...` there throws "Cannot assign to read
     only property 'getStats'", and because this block sits near the top of the
     IIFE that single throw took the entire monitor down before strategy (a) or
     (c) ever ran. A method we cannot hook costs one capture route, nothing more. */
  ['getStats', 'getSenders', 'getReceivers', 'getTransceivers', 'addIceCandidate',
   'setLocalDescription', 'setRemoteDescription', 'createOffer', 'createAnswer',
   'addTrack', 'removeTrack', 'createDataChannel'].forEach(function (m) {
    try {
      var orig = NativePC.prototype[m];
      if (typeof orig !== 'function') return;
      var hooked = function () { register(this); return orig.apply(this, arguments); };
      var d = Object.getOwnPropertyDescriptor(NativePC.prototype, m);
      if (d && !d.configurable) {
        if (d.writable) {
          NativePC.prototype[m] = hooked;                // assignable but not redefinable
          if (NativePC.prototype[m] === hooked) PATCHED_PROTO.push({
            key: m, descriptor: d, installed: Object.getOwnPropertyDescriptor(NativePC.prototype, m)
          });
        }
        return;                                            // frozen solid: leave it alone
      }
      Object.defineProperty(NativePC.prototype, m, {
        value: hooked, writable: true, configurable: true,
        enumerable: d ? d.enumerable : false
      });
      PATCHED_PROTO.push({
        key: m, descriptor: d, installed: Object.getOwnPropertyDescriptor(NativePC.prototype, m)
      });
    } catch (e) { /* keep the original; other strategies still apply */ }
  });
  ['connectionState', 'iceConnectionState', 'iceGatheringState', 'signalingState',
   'localDescription', 'remoteDescription', 'currentRemoteDescription'].forEach(function (p) {
    try {
      var d = Object.getOwnPropertyDescriptor(NativePC.prototype, p);
      if (!d || !d.get || !d.configurable) return;
      var hookedGet = function () { register(this); return d.get.call(this); };
      Object.defineProperty(NativePC.prototype, p, {
        configurable: true, enumerable: d.enumerable,
        get: hookedGet
      });
      PATCHED_PROTO.push({
        key: p, descriptor: d, installed: Object.getOwnPropertyDescriptor(NativePC.prototype, p)
      });
    } catch (e) { /* same */ }
  });

  /* (c) live connections — hunt through app state and React/Vue internals */
  var SKIP = { document: 1, location: 1, window: 1, self: 1, top: 1, parent: 1, frames: 1,
    navigator: 1, localStorage: 1, sessionStorage: 1, indexedDB: 1, performance: 1,
    history: 1, caches: 1, crypto: 1, styleSheets: 1, external: 1, opener: 1, chrome: 1 };

  function deepScan(roots, maxNodes, maxDepth) {
    var found = [], seen = new WeakSet(), q = [], n = 0, i;
    for (i = 0; i < roots.length; i++) q.push([roots[i], 0]);
    while (q.length && n < maxNodes) {
      var it = q.shift(), o = it[0], d = it[1];
      if (!o || d > maxDepth) continue;
      var t = typeof o;
      if (t !== 'object' && t !== 'function') continue;
      if (seen.has(o)) continue;
      seen.add(o); n++;
      try { if (o instanceof NativePC) { found.push(o); continue; } } catch (e) {}
      try {
        if (typeof Node !== 'undefined' && o instanceof Node) continue;
        if (o instanceof MediaStream || o instanceof MediaStreamTrack) continue;
        if (o instanceof Map) { o.forEach(function (v) { q.push([v, d + 1]); }); }
        else if (o instanceof Set) { o.forEach(function (v) { q.push([v, d + 1]); }); }
      } catch (e) {}
      var keys;
      try { keys = Object.keys(o); } catch (e) { continue; }
      if (keys.length > 300) keys = keys.slice(0, 300);
      for (i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (d === 0 && SKIP[k]) continue;
        var v; try { v = o[k]; } catch (e) { continue; }
        if (v && (typeof v === 'object' || typeof v === 'function')) q.push([v, d + 1]);
      }
    }
    return found;
  }

  function frameworkRoots() {
    var els = [document.body], containers = [], roots = [], i, k;
    for (i = 0; i < document.body.children.length && i < 40; i++) els.push(document.body.children[i]);
    for (i = 0; i < els.length; i++) {
      for (k in els[i]) {
        if (k.indexOf('__reactContainer$') === 0 || k.indexOf('__reactFiber$') === 0 ||
            k === '_reactRootContainer' || k === '__vue_app__' || k === '__vue__') {
          try { if (els[i][k]) containers.push(els[i][k]); } catch (e) {}
        }
      }
    }
    var budget = 8000;
    function walk(f) {
      while (f && budget-- > 0) {
        try {
          if (f.memoizedProps) roots.push(f.memoizedProps);
          if (f.memoizedState) roots.push(f.memoizedState);
          if (f.stateNode && typeof f.stateNode === 'object' &&
              !(typeof Node !== 'undefined' && f.stateNode instanceof Node)) roots.push(f.stateNode);
        } catch (e) {}
        if (f.child) walk(f.child);
        f = f.sibling;
      }
    }
    for (i = 0; i < containers.length; i++) {
      try { walk(containers[i].current || containers[i]); } catch (e) { roots.push(containers[i]); }
    }
    return roots;
  }

  function discover() {
    var before = PCS.length;
    try { deepScan([window], 15000, 5).forEach(register); } catch (e) {}
    if (PCS.length === before) { try { deepScan(frameworkRoots(), 45000, 7).forEach(register); } catch (e) {} }
    return PCS.length - before;
  }

  /* ================================================================== *
   * 2 — STATS COLLECTION
   * ================================================================== */
  var HIST = [], HIST_MAX = 90, STREAM_HIST = {}, LAST = null;
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

  function collectFromPC(entry, now) {
    return entry.pc.getStats().then(function (report) {
      var cur = new Map(), byId = new Map();
      report.forEach(function (s) { byId.set(s.id, s); cur.set(s.id, s); });
      var dt = entry.t ? (now - entry.t) / 1000 : 0, prev = entry.prev;
      var res = { inbound: [], outbound: [], dataChannels: [], transport: null,
                  rtt: null, avail: null, localCand: null,
                  remoteCand: null, state: null, localAudio: null };
      /* Chrome can omit inbound-rtp.trackIdentifier even though the receiver
         still exposes both its MediaStreamTrack and the active SSRC. Bridge
         those two surfaces so an SSRC-only stat can still reach its DOM media
         element (and, from there, its participant tile). */
      var receiverTracksByMid = {}, receiverTracksBySsrc = {};
      try {
        (entry.pc.getTransceivers() || []).forEach(function (transceiver) {
          if (transceiver.mid !== null && transceiver.mid !== undefined &&
              transceiver.receiver && transceiver.receiver.track) {
            receiverTracksByMid[transceiver.mid] = transceiver.receiver.track.id;
          }
        });
        (entry.pc.getReceivers() || []).forEach(function (receiver) {
          if (!receiver.track || !receiver.getSynchronizationSources) return;
          var sources = [];
          try { sources = receiver.getSynchronizationSources() || []; } catch (e) {}
          sources.forEach(function (source) {
            if (source.source !== null && source.source !== undefined) {
              receiverTracksBySsrc[source.source] = receiver.track.id;
            }
          });
        });
      } catch (e) {}
      try { res.state = entry.pc.connectionState || entry.pc.iceConnectionState; } catch (e) {}

      function delta(s, f) {
        var p = prev.get(s.id);
        if (!p || !dt) return null;
        var a = num(s[f]), b = num(p[f]);
        return (a === null || b === null) ? null : (a - b) / dt;
      }
      function codecOf(s) {
        var c = s.codecId && byId.get(s.codecId);
        if (!c) return null;
        return { name: (c.mimeType || '').split('/')[1] || c.mimeType, clock: c.clockRate,
                 channels: c.channels, fmtp: c.sdpFmtpLine };
      }

      var remoteIn = {};
      var selectedPairId = null;
      report.forEach(function (s) { if (s.type === 'remote-inbound-rtp') remoteIn[s.ssrc] = s; });
      report.forEach(function (s) {
        if (s.type === 'transport' && s.selectedCandidatePairId) selectedPairId = s.selectedCandidatePairId;
      });

      report.forEach(function (s) {
        if (s.type === 'inbound-rtp') {
          var bps = delta(s, 'bytesReceived'),
              plost = delta(s, 'packetsLost'), precv = delta(s, 'packetsReceived');
          var lossTotal = (plost !== null && precv !== null) ? precv + Math.max(0, plost) : null;
          var lossPct = (lossTotal !== null && lossTotal > 0)
            ? Math.max(0, plost) / (precv + Math.max(0, plost)) * 100 : null;
          var fps = num(s.framesPerSecond);
          if (fps === null) fps = delta(s, 'framesDecoded');
          res.inbound.push({
            id: s.id, dir: 'in', kind: s.kind || s.mediaType,
            pcKey: entry.key, mid: s.mid,
            track: s.trackIdentifier || receiverTracksByMid[s.mid] || receiverTracksBySsrc[s.ssrc], ssrc: s.ssrc,
            kbps: bps !== null ? bps * 8 / 1000 : null, codec: codecOf(s),
            w: num(s.frameWidth), h: num(s.frameHeight), fps: fps,
            jitter: num(s.jitter) !== null ? s.jitter * 1000 : null,
            lossPct: lossPct, lossLost: plost, lossTotal: lossTotal, audioLevel: num(s.audioLevel),
            jbDelay: (num(s.jitterBufferDelay) !== null && num(s.jitterBufferEmittedCount))
              ? (s.jitterBufferDelay / Math.max(1, s.jitterBufferEmittedCount)) * 1000 : null,
            framesDropped: num(s.framesDropped), freezeCount: num(s.freezeCount),
            nack: num(s.nackCount), pli: num(s.pliCount),
            decoder: s.decoderImplementation, raw: s
          });
        } else if (s.type === 'outbound-rtp') {
          var obps = delta(s, 'bytesSent'), ri = remoteIn[s.ssrc];
          var ofps = num(s.framesPerSecond);
          if (ofps === null) ofps = delta(s, 'framesSent');
          // Chrome does not expose trackIdentifier on outbound-rtp — it hangs off
          // the linked media-source stat. Without this, outgoing streams can never
          // be matched to their preview element, so they never get a name.
          var otrack = s.trackIdentifier;
          if (!otrack && s.mediaSourceId) {
            var msrc = byId.get(s.mediaSourceId);
            if (msrc) otrack = msrc.trackIdentifier;
          }
          res.outbound.push({
            id: s.id, dir: 'out', kind: s.kind || s.mediaType, track: otrack,
            pcKey: entry.key, mid: s.mid,
            ssrc: s.ssrc, rid: s.rid,
            kbps: obps !== null ? obps * 8 / 1000 : null, codec: codecOf(s),
            w: num(s.frameWidth), h: num(s.frameHeight), fps: ofps,
            limit: (s.qualityLimitationReason && s.qualityLimitationReason !== 'none') ? s.qualityLimitationReason : null,
            scalability: s.scalabilityMode, encoder: s.encoderImplementation, active: s.active,
            nack: num(s.nackCount), pli: num(s.pliCount), keyframes: num(s.keyFramesEncoded),
            rtt: ri && num(ri.roundTripTime) !== null ? ri.roundTripTime * 1000 : null,
            remoteJitter: ri && num(ri.jitter) !== null ? ri.jitter * 1000 : null,
            fraction: ri && num(ri.fractionLost) !== null ? ri.fractionLost * 100 : null,
            raw: s
          });
        } else if (s.type === 'candidate-pair' &&
                   (s.id === selectedPairId || (!selectedPairId && (s.selected || s.nominated)))) {
          if (num(s.currentRoundTripTime) !== null) res.rtt = s.currentRoundTripTime * 1000;
          if (num(s.availableOutgoingBitrate) !== null) res.avail = s.availableOutgoingBitrate / 1000;
          var lc = byId.get(s.localCandidateId), rc = byId.get(s.remoteCandidateId);
          if (lc) res.localCand = { type: lc.candidateType, proto: lc.protocol, net: lc.networkType, relay: lc.relayProtocol };
          if (rc) res.remoteCand = { type: rc.candidateType, proto: rc.protocol };
        } else if (s.type === 'media-source') {
          if (s.kind === 'audio' && num(s.audioLevel) !== null) res.localAudio = s.audioLevel;
        } else if (s.type === 'transport') {
          /* Chrome exposes the authoritative selected pair on the transport.
             Keep it for a second pass: old succeeded pairs can remain in a
             report after ICE restart, and report iteration order is arbitrary. */
          if (s.selectedCandidatePairId) {
            var selectedPair = byId.get(s.selectedCandidatePairId);
            if (selectedPair) {
              if (num(selectedPair.currentRoundTripTime) !== null) res.rtt = selectedPair.currentRoundTripTime * 1000;
              if (num(selectedPair.availableOutgoingBitrate) !== null) res.avail = selectedPair.availableOutgoingBitrate / 1000;
              var selectedLocal = byId.get(selectedPair.localCandidateId), selectedRemote = byId.get(selectedPair.remoteCandidateId);
              if (selectedLocal) res.localCand = { type: selectedLocal.candidateType, proto: selectedLocal.protocol,
                net: selectedLocal.networkType, relay: selectedLocal.relayProtocol };
              if (selectedRemote) res.remoteCand = { type: selectedRemote.candidateType, proto: selectedRemote.protocol };
            }
          }
          // Total bytes on the wire — the only honest figure when an app carries
          // media over DataChannels (Zoom web) rather than as RTP tracks.
          var tin = delta(s, 'bytesReceived'), tout = delta(s, 'bytesSent');
          res.transport = {
            /* A negative byte delta is a stats-counter reset/replacement, not
               reverse traffic. Keep that direction unknown until the next
               sample so it cannot enable transport mode or pollute history. */
            inKbps: tin !== null && tin >= 0 ? tin * 8 / 1000 : null,
            outKbps: tout !== null && tout >= 0 ? tout * 8 / 1000 : null,
            dtls: s.dtlsState, cipher: s.dtlsCipher || s.srtpCipher
          };
        } else if (s.type === 'data-channel') {
          var din = delta(s, 'bytesReceived'), dout = delta(s, 'bytesSent');
          res.dataChannels.push({
            id: s.id, pcKey: entry.key, label: s.label || 'data channel', state: s.state,
            inKbps: din !== null ? din * 8 / 1000 : null,
            outKbps: dout !== null ? dout * 8 / 1000 : null,
            msgIn: num(s.messagesReceived), msgOut: num(s.messagesSent), raw: s
          });
        }
      });

      entry.prev = cur; entry.t = now;
      return res;
    }).catch(function () { return null; });
  }

  /* which direction does each track flow? authoritative, from senders/receivers */
  function trackDirs() {
    var out = {};
    PCS.forEach(function (e) {
      try { (e.pc.getSenders() || []).forEach(function (s) { if (s.track) out[s.track.id] = 'out'; }); } catch (err) {}
      try { (e.pc.getReceivers() || []).forEach(function (r) { if (r.track) out[r.track.id] = 'in'; }); } catch (err) {}
    });
    return out;
  }

  /* device-level view — useful even before any peer connection is captured */
  var ELPREV = new WeakMap();
  function collectFromElements(now, dirs) {
    var out = [];
    dirs = dirs || {};
    var airionNames = airionNamesByIdentity();
    document.querySelectorAll('video,audio').forEach(function (el, i) {
      var s = el.srcObject;
      if (!s || !s.getTracks) return;
      s.getTracks().forEach(function (tr) {
        var st = {}; try { st = tr.getSettings() || {}; } catch (e) {}
        var isLocal = dirs[tr.id] ? dirs[tr.id] === 'out' : !!st.deviceId;
        var displayName = mediaElementParticipantName(el, isLocal, tr.kind, airionNames);
        var rec = {
          elTrack: tr.id, kind: tr.kind, label: tr.label, enabled: tr.enabled,
          trackMuted: tr.muted, state: tr.readyState,
          w: st.width || (tr.kind === 'video' ? el.videoWidth : null),
          h: st.height || (tr.kind === 'video' ? el.videoHeight : null),
          settingsFps: st.frameRate, sampleRate: st.sampleRate, channels: st.channelCount,
          ec: st.echoCancellation, ns: st.noiseSuppression, agc: st.autoGainControl,
          local: isLocal,
          name: displayName, index: i
        };
        if (tr.kind === 'video' && el.getVideoPlaybackQuality) {
          try {
            var q = el.getVideoPlaybackQuality(), p = ELPREV.get(el);
            if (p && now > p.t) rec.renderFps = (q.totalVideoFrames - p.total) / ((now - p.t) / 1000);
            rec.dropped = q.droppedVideoFrames;
            ELPREV.set(el, { t: now, total: q.totalVideoFrames, dropped: q.droppedVideoFrames });
          } catch (e) {}
        }
        out.push(rec);
      });
    });
    return out;
  }

  /* Display names are not part of WebRTC — they only exist in the page's DOM.
     Two strategies, in order of reliability:
       1. accessibility / data attributes on the tile (stable across app updates,
          and what Meet, Teams, Zoom web and most others expose for screen readers)
       2. text content near the <video> (works when there is no a11y markup)  */
  var NAME_ATTRS = ['aria-label', 'data-participant-name', 'data-name', 'data-display-name',
                    'data-self-name'];
  var NAME_JUNK = /^(video|audio|camera|microphone|mic|screen|presentation|participant|remote|local|you|muted|unmuted|off|on|pinned|speaker)$/i;
  /* Words that describe *what an element is* rather than *who it is*. A label
     built only from these is a control description, not a participant: Aloqa
     puts aria-label="Your video" on the local tile, Meet uses "Your camera",
     others "Self view" / "Local video preview". Matching only single words
     (NAME_JUNK) let "Your video" through, and because attributes are checked
     before tile text it won every time — every local card was named after the
     element instead of the person. */
  var NAME_JUNK_WORD = /^(your|my|own|self|local|remote|the|a|an|is|video|audio|camera|microphone|mic|screen|share|shared|sharing|view|feed|stream|preview|presentation|participant|placeholder|avatar|thumbnail|tile|muted|unmuted|off|on|pinned|speaker|you|excellent|good|fair|poor|weak|strong|unstable|connection|quality|signal|network|status|reconnecting|connecting|connected|disconnected|speaking|raised|hand|reaction|guest|host|owner|admin|moderator)$/i;
  var NAME_UI_LABEL = /^(?:call participants|your video|participant video|participant actions for(?:\s|$).*|Участники звонка|Ваше видео|Видео участника|Действия участника(?:\s|$).*|Qo[ʻ'’]?ng[ʻ'’]?iroq qatnashchilari|Sizning videongiz|Qatnashchi videosi|.*(?:\s|^)ishtirokchi amallari|Қўнғироқ қатнашчилари|Сизнинг видеонгиз|Қатнашчи видеоси|.*(?:\s|^)иштирокчи амаллари)$/i;
  /* Meet puts capture state, not identity, in the pre-join video's aria-label.
     Keep this deliberately phrase-shaped: words such as "video", "preview"
     or "включен" may legitimately occur in a display name on their own. */
  var NAME_MEDIA_PREVIEW = /^(?:(?:video|camera) preview\s+(?:is\s+)?(?:on|off|enabled|disabled)|(?:предварительный просмотр|предпросмотр) (?:видео|камеры)(?:\s*[:—-]?\s*(?:включ[её]н(?:а|о)?|выключ[её]н(?:а|о)?))?)$/i;
  function allJunkWords(txt) {
    var parts = txt.split(/[\s\-_,./]+/).filter(Boolean);
    if (!parts.length || parts.length > 4) return false;  // real names are short; long strings judged elsewhere
    for (var i = 0; i < parts.length; i++) if (!NAME_JUNK_WORD.test(parts[i])) return false;
    return true;
  }

  function firstTrackId(el) {
    try {
      var t = el && el.srcObject && el.srcObject.getTracks && el.srcObject.getTracks()[0];
      return t ? t.id : null;
    } catch (e) { return null; }
  }

  /* True when `node` contains media that belongs to someone other than `self`.
     An element with nothing attached is skipped rather than counted: Meet keeps
     empty <video> placeholders inside a tile, and treating those as an unknown
     occupant stopped the climb one level below the participant's name. */
  function hasForeignMedia(node, sel, self, ownTrack) {
    var peers = node.querySelectorAll(sel);
    for (var i = 0; i < peers.length; i++) {
      if (peers[i] === self) continue;
      var t = firstTrackId(peers[i]);
      if (!t) continue;                        // placeholder, attributable to nobody
      if (!ownTrack || t !== ownTrack) return true;
    }
    return false;
  }

  /* Tiles often render the name twice — once visibly, once for screen readers —
     and glue an icon ligature onto the end, so textContent reads
     "Mahmud NosirovMahmud Nosirovdevices". Taking the repeated prefix recovers
     the name and drops the trailing ligature in one step. */
  function dedupeDoubled(txt) {
    for (var i = Math.floor(txt.length / 2); i >= 3; i--) {
      if (txt.slice(i, i * 2) === txt.slice(0, i)) return txt.slice(0, i).trim();
    }
    return txt;
  }

  /* Pull a name out of a container whose own text is a run-on of controls plus
     the name. Only leaf nodes count, controls are skipped (their labels describe
     actions, not people), and a candidate carrying a capital is preferred —
     display names nearly always have one, stray control text often does not. */
  function nameFromDescendants(node) {
    var kids, i, k, v, counts = {}, order = [];
    try { kids = node.querySelectorAll('*'); } catch (e) { return null; }
    for (i = 0; i < kids.length && i < 80; i++) {
      k = kids[i];
      if (k.children && k.children.length) continue;              // leaves only
      /* Controls describe actions, not people. Match the control roles only —
         NOT [jsaction]: Meet puts a jsaction on the whole tile, so excluding it
         threw away every candidate including the name itself. */
      try {
        if (k.closest && k.closest('button,[role="button"],[role="menuitem"],[role="tab"],[role="img"],[role="status"],[role="tooltip"],[aria-hidden="true"]')) continue;
      } catch (e) {}
      v = cleanName(k.textContent);
      if (!v) continue;
      if (!counts[v]) { counts[v] = 0; order.push(v); }
      counts[v]++;
    }
    /* A separator is positive evidence that a leaf is a display name. Current
       Meet renders the name in sibling text containers, but its hover tools can
       also duplicate tooltip text. Requiring a name-like separator keeps the
       latter (for example "Кадрировать") out without requiring a particular
       number of duplicate accessibility nodes. */
    var nameLike = order.filter(function (v) { return /[\s.·@]/.test(v); });
    for (i = 0; i < nameLike.length; i++) if (counts[nameLike[i]] > 1) return nameLike[i];
    return nameLike.length === 1 ? nameLike[0] : null;
  }

  function cleanName(txt) {
    if (!txt) return null;
    txt = String(txt).replace(/\s+/g, ' ').trim();
    if (!txt || txt.length > 90) return null;            // sanity bound before de-doubling
    if (/^[\d\s:.%]+$/.test(txt)) return null;           // timers, counters
    if (NAME_UI_LABEL.test(txt) || NAME_MEDIA_PREVIEW.test(txt)) return null;
    // Material icon ligatures render as text and leak into textContent:
    // "more_vert", "frame_person", "visual_effects". No display name looks
    // like that, and they sit right next to the name in Meet's tiles.
    if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(txt)) return null;
    txt = dedupeDoubled(txt);
    if (NAME_UI_LABEL.test(txt) || NAME_MEDIA_PREVIEW.test(txt)) return null;
    if (txt.length > 40) return null;                    // a real name, not a paragraph
    if (NAME_JUNK.test(txt)) return null;                // generic control labels
    if (allJunkWords(txt)) return null;                  // "Your video", "Self view", "Screen share"
    // trim trailing state words a11y labels append: "Mahmud, muted" / "Mahmud (presenting)"
    txt = txt.replace(/[,;]\s*(muted|unmuted|camera (on|off)|video (on|off)|presenting|speaking|pinned|guest|host)\b.*$/i, '');
    txt = txt.replace(/\s*\((presenting|speaking|pinned|screen share)\)\s*$/i, '');
    // split a role badge glued straight onto the name. Aloqa renders the badge
    // in caps ("Guest TesterGUEST"), so match case-insensitively; the preceding
    // lowercase/digit is what proves it is a glued-on badge and not a surname.
    txt = txt.replace(/([a-z0-9])(guest|host|owner|admin|moderator|speaker|presenter)$/i, '$1');
    txt = txt.trim();
    return (txt && txt.length <= 40 && !NAME_JUNK.test(txt) && !allJunkWords(txt)) ? txt : null;
  }

  /* A stable participant-name hook is an identity contract, so it is allowed
     to carry a display name which would be ambiguous in generic page text.
     Airion's anonymous attendee is literally named "Guest": cleanName rejects
     that word elsewhere because it is commonly a role badge, but rejecting it
     inside [data-testid="participant-name"] loses the real participant name. */
  function explicitIdentityName(label) {
    if (!label) return null;
    var raw = label.textContent || label.getAttribute('aria-label');
    var cleaned = cleanName(raw);
    if (cleaned) return cleaned;
    raw = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!raw || raw.length > 40 || /^[\d\s:.%]+$/.test(raw)) return null;
    if (NAME_UI_LABEL.test(raw) || NAME_MEDIA_PREVIEW.test(raw)) return null;
    if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(raw)) return null;
    return raw;
  }

  /* Aloqa exposes stable ownership hooks. Resolve those before generic aria
     labels: the same tile also contains localized media/status/action labels,
     none of which identify the person. */
  function explicitParticipantName(el) {
    try {
      var tile = el && el.closest && el.closest('[data-testid="participant-tile"]');
      var label = tile && tile.querySelector('[data-testid="participant-name"]');
      return explicitIdentityName(label);
    } catch (e) { return null; }
  }

  /* React does not publish component props as DOM attributes, but it leaves one
     private Fiber pointer on each host node. Airion's detached audio sink has no
     participant DOM ancestry; its RemoteAudioElement Fiber is the only place
     where the exact streamKey ownership contract survives. Walk only `.return`,
     cap the depth, and inspect only props — never crawl arbitrary Fiber objects. */
  function reactPropsForNode(node) {
    var keys = [], fiber = null, out = [];
    try { keys = Object.getOwnPropertyNames(node || {}); } catch (e) {}
    for (var i = 0; i < keys.length; i++) {
      if (/^__(?:reactFiber|reactInternalInstance)\$/.test(keys[i])) {
        try { fiber = node[keys[i]]; } catch (e) {}
        if (fiber) break;
      }
    }
    for (var depth = 0; fiber && depth < 16; depth++) {
      var props = null, next = null;
      try {
        props = fiber.memoizedProps;
        if (props === null || props === undefined) props = fiber.pendingProps;
        next = fiber.return;
      } catch (e) { break; }
      if (props && typeof props === 'object') out.push(props);
      fiber = next;
    }
    return out;
  }

  function normalizedTileIdentity(props) {
    if (!props || typeof props !== 'object') return null;
    var direct = typeof props.remoteParticipantId === 'string' ? props.remoteParticipantId : null;
    var participant = props.participant, derived = null;
    if (participant && typeof participant === 'object' && typeof participant.user_id === 'string') {
      derived = participant.is_guest && participant.user_id.slice(0, 6) !== 'guest:'
        ? 'guest:' + participant.user_id : participant.user_id;
    }
    if (direct && derived && direct !== derived) return false;
    return direct || derived;
  }

  function identityFromParticipantTile(tile) {
    var props = reactPropsForNode(tile), identities = {};
    for (var i = 0; i < props.length; i++) {
      var id = normalizedTileIdentity(props[i]);
      if (id === false) return null;
      if (id) identities[id] = true;
    }
    var keys = Object.keys(identities);
    return keys.length === 1 ? keys[0] : null;
  }

  function airionNamesByIdentity() {
    var tiles = [], result = {}, conflicts = {};
    try { tiles = document.querySelectorAll('[data-testid="participant-tile"][data-local="false"]'); } catch (e) {}
    for (var i = 0; i < tiles.length; i++) {
      var label = null;
      try { label = tiles[i].querySelector('[data-testid="participant-name"]'); } catch (e) {}
      var name = explicitIdentityName(label), id = identityFromParticipantTile(tiles[i]);
      if (!name || !id) continue;
      if (result[id] && result[id] !== name) conflicts[id] = true;
      else result[id] = name;
    }
    Object.keys(conflicts).forEach(function (id) { delete result[id]; });
    return result;
  }

  function participantFromAudioStreamKey(key) {
    if (typeof key !== 'string') return null;
    var match = /^(?:primary|breakout):(.+?):(?:microphone|screen-audio):(.+)$/.exec(key);
    if (!match) match = /^auxiliary:(.+?):(?:microphone|screen_share_audio):(.+)$/.exec(key);
    return match ? match[1] : null;
  }

  function isAirionRemoteAudioSink(el) {
    try { return el.getAttribute('data-testid') === 'remote-audio-sink'; } catch (e) { return false; }
  }

  function detachedAudioIdentity(el) {
    if (!isAirionRemoteAudioSink(el)) return null;
    var props = reactPropsForNode(el), identities = {};
    for (var i = 0; i < props.length; i++) {
      if (props[i].stream !== el.srcObject) continue;
      var id = participantFromAudioStreamKey(props[i].streamKey);
      if (id) identities[id] = true;
    }
    var keys = Object.keys(identities);
    return keys.length === 1 ? keys[0] : null;
  }

  function airionDetachedMediaName(el, namesByIdentity) {
    var id = detachedAudioIdentity(el);
    return id && namesByIdentity[id] || null;
  }

  function mediaElementParticipantName(el, isLocal, kind, namesByIdentity) {
    /* A body-level Airion audio sink has no participant DOM boundary. Exact
       Fiber identity is authoritative; if it cannot be proved, fail closed to
       the SSRC label rather than climbing into unrelated page text. */
    if (!isLocal && isAirionRemoteAudioSink(el)) {
      return airionDetachedMediaName(el, namesByIdentity);
    }
    return participantName(el, isLocal && kind === 'video');
  }

  var DOC_NAME_CACHE = { t: 0, value: null };
  function documentParticipantName() {
    var now = Date.now();
    if (now - DOC_NAME_CACHE.t < 2500) return DOC_NAME_CACHE.value;
    var counts = {}, order = [], siblingParent = {}, nodes = [];
    try { nodes = document.querySelectorAll('div,span'); } catch (e) {}
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i], v;
      if ((n.children && n.children.length) || !n.textContent) continue;
      try {
        if (n.closest('button,[role="button"],[role="menuitem"],[role="tab"],[role="img"],[role="status"],[role="tooltip"],[aria-hidden="true"]')) continue;
      } catch (e) {}
      v = cleanName(n.textContent);
      if (!v || !/[\s.·@]/.test(v)) continue;
      if (!counts[v]) { counts[v] = 0; order.push(v); siblingParent[v] = n.parentElement || null; }
      else if (siblingParent[v] !== (n.parentElement || null)) siblingParent[v] = false;
      counts[v]++;
    }
    var repeated = order.filter(function (v) { return counts[v] > 1 && siblingParent[v]; });
    DOC_NAME_CACHE = { t: now, value: repeated.length === 1 ? repeated[0] : null };
    return DOC_NAME_CACHE.value;
  }

  function participantName(el, allowDocumentFallback) {
    var n = el, depth = 0, best = null, i, v;
    v = explicitParticipantName(el);
    if (v) return v;
    // Match the starting element's own kind so a tile that pairs a <video>
    // with its own <audio> is not mistaken for a container.
    var peerSel = el && el.tagName === 'AUDIO' ? 'audio' : 'video';
    var ownTrack = firstTrackId(el);
    while (n && depth++ < 7) {
      // 1. attributes on this element
      for (i = 0; i < NAME_ATTRS.length; i++) {
        if (!n.getAttribute) continue;
        v = cleanName(n.getAttribute(NAME_ATTRS[i]));
        if (v) return v;
      }
      // 1b. a labelled descendant (Meet/Teams put the name on a nested node)
      if (depth > 1 && n.querySelector) {
        try {
          var labelled = n.querySelectorAll('[data-testid="participant-name"],[aria-label],[data-participant-name],[data-self-name]');
          for (i = 0; i < labelled.length && i < 6; i++) {
            try {
              if (labelled[i].closest('button,[role="button"],[role="menuitem"],[role="tab"],[role="img"],[role="status"],[role="tooltip"],[aria-hidden="true"]')) continue;
            } catch (e) {}
            v = cleanName(labelled[i].getAttribute('aria-label') ||
                          labelled[i].getAttribute('data-participant-name') ||
                          labelled[i].getAttribute('data-self-name') ||
                          labelled[i].textContent);
            if (v) return v;
          }
        } catch (e) {}
      }
      n = n.parentElement;
      if (!n) break;
      /* Stop once an ancestor holds media belonging to somebody *else* — that is
         the grid, whose label names the region ("Call participants") and whose
         text is every participant concatenated. The length guard below cannot
         catch it: two short names ("Guest TesterGuestTest2 (you)") are only 28
         characters.
         Counting elements is the wrong test, though. Meet renders one
         participant into two <video> elements sharing a single track, so "more
         than one video" stopped the climb inside the tile and every Meet card
         lost its name. Compare track identity instead: same track means the same
         person, however many elements they are painted into. */
      try {
        if (n.querySelectorAll && hasForeignMedia(n, peerSel, el, ownTrack)) break;
      } catch (e) {}
      // 2. text near the video
      var txt = (n.textContent || '').replace(/\s+/g, ' ').trim();
      if (txt.length > 40) {
        /* Too long to be a name, but the name may still be a leaf inside it.
           Meet's self-view tile concatenates its hover toolbar with the
           participant name — "frame_personКадрироватьvisual_effects…Mahmud
           Nosirov" — so giving up here left every local card unnamed. */
        v = nameFromDescendants(n);
        if (v) best = v;
        break;
      }
      v = cleanName(txt);
      if (v) best = v;
    }
    return best || (allowDocumentFallback ? documentParticipantName() : null);
  }

  function receiverLevels() {
    var map = {};
    PCS.forEach(function (e) {
      var rs; try { rs = e.pc.getReceivers(); } catch (err) { return; }
      (rs || []).forEach(function (r) {
        if (!r.track || r.track.kind !== 'audio' || !r.getSynchronizationSources) return;
        try {
          var ss = r.getSynchronizationSources();
          if (ss && ss.length && typeof ss[0].audioLevel === 'number') map[r.track.id] = ss[0].audioLevel;
        } catch (err) {}
      });
    });
    return map;
  }

  /* ================================================================== *
   * 3 — MODEL
   * ================================================================== */
  function pruneStreamState(m) {
    var streams = Object.create(null), cards = Object.create(null);
    m.inbound.concat(m.outbound).forEach(function (s) {
      streams[s.id] = true;
      cards[s.id] = true;
    });
    (m.elements || []).forEach(function (e) { cards['el:' + e.elTrack] = true; });
    Object.keys(STREAM_HIST).forEach(function (id) {
      if (!streams[id]) delete STREAM_HIST[id];
    });
    Object.keys(expanded).forEach(function (id) {
      if (!cards[id]) delete expanded[id];
    });
  }

  function groupedZoomMediaChannels(m) {
    if (typeof IS_ZOOM_WEBCLIENT_REALM === 'undefined' || !IS_ZOOM_WEBCLIENT_REALM ||
        m.inbound.length || m.outbound.length) return [];

    var groups = {};
    (m.dataChannels || []).forEach(function (channel) {
      var kind = channel.label === 'ZoomWebclientAudioDataChannel' ? 'audio'
        : (channel.label === 'ZoomWebclientVideoDataChannel' ? 'video' : null);
      /* An exact label is necessary but not sufficient. Closed/closing channel
         stats can survive in a report after replacement; do not count those as
         a current Zoom media source. A missing state is weaker evidence than
         `open`: it may use a positive current delta, never cumulative-only or
         idle evidence. */
      var stateMissing = channel.state === null || channel.state === undefined || channel.state === '';
      if (!kind || (!stateMissing && channel.state !== 'open')) return;
      var inRate = num(channel.inKbps), outRate = num(channel.outKbps);
      var rawIn = num(channel.raw && channel.raw.bytesReceived);
      var rawOut = num(channel.raw && channel.raw.bytesSent);
      var inRateValid = inRate !== null && inRate >= 0;
      var outRateValid = outRate !== null && outRate >= 0;
      /* Negative deltas mean a counter reset/replacement, not reverse traffic.
         Do not let old cumulative bytes turn that reset sample into an `idle`
         channel. Null is the legitimate first-sample case; zero is a legitimate
         idle sample only after lifetime bytes prove prior activity. */
      var inEvidence = stateMissing ? (inRate !== null && inRate > 0)
        : (inRateValid
          ? (inRate > 0 || (rawIn !== null && rawIn > 0))
          : (inRate === null && rawIn !== null && rawIn > 0));
      var outEvidence = stateMissing ? (outRate !== null && outRate > 0)
        : (outRateValid
          ? (outRate > 0 || (rawOut !== null && rawOut > 0))
          : (outRate === null && rawOut !== null && rawOut > 0));
      if (!inEvidence && !outEvidence) return;
      var group = groups[kind];
      if (!group) {
        group = groups[kind] = {
          id: 'zoom-channel-' + kind,
          kind: kind,
          inKbps: 0,
          outKbps: 0,
          sourceCount: 0,
          pcKeys: [],
          cumulativeInBytes: 0,
          cumulativeOutBytes: 0,
          hasInRate: false,
          hasOutRate: false
        };
      }
      group.sourceCount++;
      if (group.pcKeys.indexOf(channel.pcKey) < 0) group.pcKeys.push(channel.pcKey);
      if (inRateValid) {
        group.hasInRate = true;
        group.inKbps += inRate;
      }
      if (outRateValid) {
        group.hasOutRate = true;
        group.outKbps += outRate;
      }
      if (rawIn !== null) group.cumulativeInBytes += Math.max(0, rawIn);
      if (rawOut !== null) group.cumulativeOutBytes += Math.max(0, rawOut);
    });

    return ['audio', 'video'].map(function (kind) {
      var group = groups[kind];
      /* The first report has no delta yet. Cumulative bytes prove that the
         channel really carried media, so render it with an honest `—` rate.
         Conversely, a merely-open exact-label channel with null/zero deltas
         and zero lifetime bytes is inactive evidence and stays out of view. */
      if (!group) return null;
      if (!group.hasInRate) group.inKbps = null;
      if (!group.hasOutRate) group.outKbps = null;
      delete group.hasInRate;
      delete group.hasOutRate;
      return group;
    }).filter(Boolean);
  }

  function tick() {
    var now = Date.now();
    var live = PCS.filter(function (e) {
      try { return e.pc.signalingState !== 'closed'; } catch (err) { return false; }
    });
    PCS = live; // release closed PCs and their per-stat history after repeated joins
    return Promise.all(live.map(function (e) { return collectFromPC(e, now); })).then(function (parts) {
      parts = parts.filter(Boolean);
      var m = { t: now, pcs: live.length, inbound: [], outbound: [], dataChannels: [],
                zoomMediaChannels: [],
                tIn: null, tOut: null, dtls: null, rtt: null, avail: null,
                localCand: null, remoteCand: null, states: [], localAudio: null };
      parts.forEach(function (p) {
        m.inbound = m.inbound.concat(p.inbound);
        m.outbound = m.outbound.concat(p.outbound);
        if (p.dataChannels && p.dataChannels.length) m.dataChannels = m.dataChannels.concat(p.dataChannels);
        if (p.transport) {
          if (p.transport.inKbps !== null) m.tIn = (m.tIn || 0) + p.transport.inKbps;
          if (p.transport.outKbps !== null) m.tOut = (m.tOut || 0) + p.transport.outKbps;
          if (!m.dtls) m.dtls = p.transport.dtls;
        }
        if (p.rtt !== null && (m.rtt === null || p.rtt > m.rtt)) m.rtt = p.rtt;
        if (p.avail !== null) m.avail = (m.avail || 0) + p.avail;
        if (p.localCand && !m.localCand) m.localCand = p.localCand;
        if (p.remoteCand && !m.remoteCand) m.remoteCand = p.remoteCand;
        if (p.state && m.states.indexOf(p.state) < 0) m.states.push(p.state);
        if (p.localAudio != null) m.localAudio = p.localAudio;
      });
      m.elements = collectFromElements(now, trackDirs());
      m.levels = receiverLevels();
      // A failed getStats() is not evidence that its streams ended. Prune only
      // after every still-live PC returned a report; this releases state from
      // closed/replaced SPA calls without erasing history on a transient read.
      if (parts.length === live.length) pruneStreamState(m);

      // No RTP tracks but bytes are moving: the app tunnels media through
      // DataChannels. Fall back to transport totals and say so in the UI.
      var zeroRtp = (m.inbound.length + m.outbound.length) === 0;
      var zoomMediaChannels = groupedZoomMediaChannels(m);
      /* A first getStats sample has cumulative counters but no delta yet, and a
         currently-idle channel has a zero delta. Exact active Zoom media labels
         plus positive lifetime bytes are enough to preserve transport mode in
         both cases; an unused zero-byte channel is not. */
      m.viaTransport = zeroRtp && (!!(m.tIn || m.tOut) || zoomMediaChannels.length > 0);
      /* Zoom names its two media channel classes explicitly. They still carry
         combined traffic for all participants, not RTP streams, so expose only
         an estimated per-kind aggregate and never attach person/codec/loss/fps
         claims. Raw DataChannel stats remain model/dump-only. */
      m.zoomMediaChannels = m.viaTransport ? zoomMediaChannels : [];
      m.down = m.viaTransport ? m.tIn : m.inbound.reduce(function (a, s) { return a + (s.kbps || 0); }, 0);
      m.up = m.viaTransport ? m.tOut : m.outbound.reduce(function (a, s) { return a + (s.kbps || 0); }, 0);
      /* Weight aggregate loss by packets. Equal-weighting per-stream percentages
         makes one packet on an idle Airion SFU layer dominate busy video. */
      var lostPackets = 0, totalPackets = 0;
      m.inbound.forEach(function (s) {
        if (s.lossLost !== null && s.lossTotal !== null) {
          lostPackets += Math.max(0, s.lossLost); totalPackets += Math.max(0, s.lossTotal);
        }
      });
      m.loss = totalPackets ? lostPackets / totalPackets * 100 : null;
      m.jitter = m.inbound.reduce(function (a, s) { return s.jitter !== null ? Math.max(a, s.jitter) : a; }, 0) || null;
      if (m.rtt === null) {
        var r = m.outbound.filter(function (s) { return s.rtt !== null; });
        if (r.length) m.rtt = r.reduce(function (a, s) { return Math.max(a, s.rtt); }, 0);
      }
      var lim = m.outbound.filter(function (s) { return s.limit; })[0];
      m.limit = lim ? lim.limit : null;

      if (m.pcs) {
        HIST.push({ t: now, down: m.down, up: m.up });
        if (HIST.length > HIST_MAX) HIST.shift();
        m.inbound.concat(m.outbound).forEach(function (s) {
          if (!STREAM_HIST[s.id]) STREAM_HIST[s.id] = [];
          STREAM_HIST[s.id].push(s.kbps || 0);
          if (STREAM_HIST[s.id].length > 40) STREAM_HIST[s.id].shift();
        });
      }
      LAST = m;
      return m;
    });
  }

  function quality(m) {
    if (!m.pcs) return { lvl: 0, label: 'No connection', color: C.muted };
    /* Transport-only mode has no RTP loss/jitter or media-quality evidence.
       RTT proves connectivity, not Excellent/Good/Poor media quality. */
    if (m.viaTransport) return { lvl: 2, label: 'Connected', color: C.good };
    var rtt = m.rtt, loss = m.loss || 0, jit = m.jitter || 0;
    if (rtt === null) return { lvl: 2, label: 'Connected', color: C.good };
    if (rtt < 100 && loss < 0.5 && jit < 20) return { lvl: 4, label: 'Excellent', color: C.good };
    if (rtt < 200 && loss < 2 && jit < 40) return { lvl: 3, label: 'Good', color: C.good };
    if (rtt < 350 && loss < 5) return { lvl: 2, label: 'Fair', color: C.warn };
    return { lvl: 1, label: 'Poor', color: C.crit };
  }

  /* ================================================================== *
   * 4 — FORMATTERS
   * ================================================================== */
  function fmtRate(k) {
    if (k === null || k === undefined || !isFinite(k)) return '—';
    if (k >= 1000) return (k / 1000).toFixed(k >= 10000 ? 0 : 1) + ' Mbps';
    if (k >= 10) return Math.round(k) + ' kbps';
    if (k > 0) return k.toFixed(1) + ' kbps';
    return '0 kbps';
  }
  function fmtMs(v, d) { return (v === null || v === undefined || !isFinite(v)) ? '—' : v.toFixed(d === undefined ? 0 : d) + ' ms'; }
  function fmtPct(v) { return (v === null || v === undefined || !isFinite(v)) ? '—' : ((v > 0 && v < 0.05) ? '<0.1' : v.toFixed(1)) + '%'; }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  var SEP = '<span style="color:' + C.axis + '">·</span>';
  function fade(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* Trusted Types. Google Meet (and any site sending
   * `require-trusted-types-for 'script'`) rejects every plain-string innerHTML
   * assignment in the renderer below, so the panel throws on its first paint.
   * Registering our own policy is the sanctioned way for page code to keep
   * using innerHTML under enforcement — it is not a bypass; the site still
   * decides, via the `trusted-types` directive, whether this name is allowed.
   * The policy is cached on window so re-running the script (the toggle path)
   * doesn't hit the duplicate-name error. Sites with no enforcement fall
   * through to the raw string and behave exactly as before. */
  var trust = (function () {
    var KEY = '__rtcStreamMonitorTT__';
    var tt = window.trustedTypes;
    if (!tt || !tt.createPolicy) return function (s) { return s; };
    var policy = window[KEY];
    if (!policy) {
      try {
        policy = tt.createPolicy('rtc-stream-monitor', { createHTML: function (s) { return s; } });
        window[KEY] = policy;
      } catch (e) {
        // CSP restricts policy names. The page's own default policy is the
        // only remaining option; it may sanitise, but a stripped panel beats
        // no panel.
        policy = tt.defaultPolicy || null;
      }
    }
    return policy ? function (s) { return policy.createHTML(s); } : function (s) { return s; };
  })();

  /* ================================================================== *
   * 5 — SHELL
   * ================================================================== */
  var host = document.createElement('div');
  host.id = 'rtc-stream-monitor-host';
  host.style.cssText = 'position:fixed;z-index:2147483000;top:0;left:0;width:0;height:0';
  (document.body || document.documentElement).appendChild(host);
  var root = host.attachShadow({ mode: 'open' });

  root.innerHTML = trust(
  '<style>' +
  ':host{all:initial}*{box-sizing:border-box;margin:0;padding:0}' +
  '.p{position:fixed;top:16px;right:16px;width:412px;height:auto;max-height:86vh;min-width:330px;' +
    'display:flex;flex-direction:column;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;' +
    'font-size:12px;line-height:1.45;color:' + C.ink + ';background:rgba(26,26,25,.95);' +
    'backdrop-filter:blur(16px) saturate(1.3);-webkit-backdrop-filter:blur(16px) saturate(1.3);' +
    'border:1px solid ' + C.border + ';border-radius:14px;box-shadow:0 20px 56px rgba(0,0,0,.6);overflow:hidden}' +
  '.hd{display:flex;align-items:center;gap:8px;padding:10px 12px;background:rgba(13,13,13,.75);' +
    'border-bottom:1px solid ' + C.border + ';cursor:grab;user-select:none;flex:0 0 auto}' +
  '.hd:active{cursor:grabbing}.hd .ttl{font-weight:600;letter-spacing:.2px;flex:1}' +
  '.hd .sub{color:' + C.muted + ';font-weight:400;font-size:11px}' +
  '.ib{width:24px;height:24px;display:grid;place-items:center;border-radius:6px;border:0;background:transparent;' +
    'color:' + C.muted + ';cursor:pointer;font-size:13px;line-height:1;font-family:inherit}' +
  '.ib:hover{background:rgba(255,255,255,.09);color:' + C.ink + '}' +
  '.bd{overflow-y:auto;overflow-x:hidden;flex:1 1 auto;min-height:0;overscroll-behavior:contain;' +
    'padding:0 12px 14px;scrollbar-width:thin}' +
  '.bd::-webkit-scrollbar{width:8px}.bd::-webkit-scrollbar-thumb{background:' + C.axis + ';border-radius:8px}' +
  '.p.min .bd,.p.min .rz{display:none}.p.min{height:auto!important}' +
  '.hero{display:flex;align-items:flex-end;gap:12px;padding:14px 0 11px}' +
  '.hero .n{font-size:48px;font-weight:600;letter-spacing:-1.6px;line-height:.95}' +
  '.hero .u{font-size:13px;color:' + C.muted + ';padding-bottom:5px}' +
  '.lbl{color:' + C.muted + ';font-size:10.5px;margin-bottom:5px}' +
  '.q{margin-left:auto;text-align:right;padding-bottom:3px}' +
  '.qrow{display:flex;align-items:center;gap:6px;justify-content:flex-end}' +
  '.qlab{font-weight:600}.bars{display:flex;align-items:flex-end;gap:2px;height:12px}' +
  '.bars i{width:3px;border-radius:1px}' +
  '.tiles{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:' + C.border + ';' +
    'border:1px solid ' + C.border + ';border-radius:10px;overflow:hidden}' +
  '.tile{background:' + C.surface + ';padding:9px 11px}' +
  '.tile .l{color:' + C.muted + ';font-size:10.5px;display:flex;align-items:center;gap:5px}' +
  '.tile .v{font-size:19px;font-weight:600;letter-spacing:-.3px;margin-top:1px}' +
  '.dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex:0 0 auto}' +
  '.sec{margin-top:14px}' +
  '.sech{display:flex;align-items:center;gap:8px;color:' + C.ink2 + ';font-size:10.5px;font-weight:600;' +
    'letter-spacing:.5px;text-transform:uppercase;margin-bottom:7px}' +
  '.sech .c{color:' + C.muted + ';font-weight:500}.sech .sp{flex:1;height:1px;background:' + C.grid + '}' +
  '.lg{display:flex;align-items:center;gap:12px;font-size:11px;color:' + C.ink2 + ';margin-bottom:5px}' +
  '.lg span{display:flex;align-items:center;gap:5px}.lg i{width:12px;height:2px;border-radius:1px}' +
  '.lgbtn{margin-left:auto;border:1px solid ' + C.border + ';background:transparent;color:' + C.muted + ';' +
    'border-radius:5px;font-size:10px;padding:2px 7px;cursor:pointer;font-family:inherit}' +
  '.lgbtn:hover{color:' + C.ink + ';background:rgba(255,255,255,.07)}' +
  '.chw{position:relative;background:' + C.surface + ';border:1px solid ' + C.border + ';border-radius:10px;padding:8px 10px 6px}' +
  '.chw:focus-visible{outline:2px solid ' + C.inb + ';outline-offset:1px}' +
  '.tt{position:absolute;pointer-events:none;background:rgba(13,13,13,.97);border:1px solid ' + C.border + ';' +
    'border-radius:7px;padding:6px 8px;font-size:11px;white-space:nowrap;display:none;z-index:5;' +
    'box-shadow:0 6px 18px rgba(0,0,0,.55)}' +
  '.tt .r{display:flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums}' +
  '.tbl{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:11px}' +
  '.tbl th{text-align:right;color:' + C.muted + ';font-weight:500;padding:3px 6px;border-bottom:1px solid ' + C.grid + '}' +
  '.tbl th:first-child,.tbl td:first-child{text-align:left}' +
  '.tbl td{text-align:right;padding:3px 6px;color:' + C.ink2 + '}' +
  '.tblw{max-height:158px;overflow:auto;background:' + C.surface + ';border:1px solid ' + C.border + ';border-radius:10px;padding:6px 4px}' +
  '.card{background:' + C.surface + ';border:1px solid ' + C.border + ';border-radius:10px;padding:9px 10px;margin-bottom:6px}' +
  '.crow{display:flex;align-items:center;gap:7px}' +
  '.cttl{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}' +
  '.cbps{font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}' +
  '.meta{color:' + C.muted + ';font-size:11px;margin-top:3px;display:flex;flex-wrap:wrap;gap:3px 8px;align-items:center}' +
  '.meta b{color:' + C.ink2 + ';font-weight:500}' +
  '.mtr{height:6px;border-radius:3px;background:' + C.track + ';overflow:hidden;margin-top:7px}' +
  '.mtr i{display:block;height:100%;border-radius:3px;transition:width .1s linear}' +
  '.spark{display:block;margin-top:6px}' +
  '.exp{margin-top:8px;border-top:1px solid ' + C.grid + ';padding-top:7px;display:none;' +
    'grid-template-columns:auto 1fr;gap:2px 12px;font-size:10.5px;font-variant-numeric:tabular-nums;' +
    'max-height:210px;overflow:auto}' +
  '.exp.on{display:grid}.exp dt{color:' + C.muted + ';white-space:nowrap}.exp dd{color:' + C.ink2 + ';word-break:break-all}' +
  '.chev{border:0;background:transparent;color:' + C.muted + ';cursor:pointer;font-size:11px;padding:0 2px;font-family:inherit}' +
  '.chev:hover{color:' + C.ink + '}' +
  '.note{background:rgba(250,178,25,.10);border:1px solid rgba(250,178,25,.32);border-radius:10px;' +
    'padding:9px 11px;font-size:11.5px;color:' + C.ink2 + ';margin-top:12px;display:flex;gap:8px;align-items:flex-start}' +
  '.note b{color:' + C.ink + ';font-weight:600}' +
  '.note button{margin-top:7px;border:1px solid ' + C.border + ';background:rgba(255,255,255,.07);color:' + C.ink + ';' +
    'border-radius:6px;padding:3px 9px;font-size:11px;cursor:pointer;font-family:inherit}' +
  '.note button:hover{background:rgba(255,255,255,.13)}' +
  '.pill{border:1px solid ' + C.border + ';border-radius:999px;padding:0 7px;font-size:10px;color:' + C.ink2 + '}' +
  '.rz{position:absolute;left:0;bottom:0;width:16px;height:16px;cursor:nesw-resize;opacity:.5}' +
  '.rz:before{content:"";position:absolute;left:4px;bottom:4px;width:7px;height:7px;' +
    'border-left:1.5px solid ' + C.muted + ';border-bottom:1.5px solid ' + C.muted + '}' +
  '</style>' +
  '<div class="p" id="panel">' +
    '<div class="hd" id="hd">' +
      '<span class="dot" id="hdot" style="background:' + C.muted + '"></span>' +
      '<span class="ttl">Stream Monitor <span class="sub" id="hsub"></span></span>' +
      '<button class="ib" id="bcopy" title="Copy full stats JSON to clipboard">⧉</button>' +
      '<button class="ib" id="bmin" title="Minimise">—</button>' +
      '<button class="ib" id="bcls" title="Close">✕</button>' +
    '</div>' +
    '<div class="bd" id="body"></div>' +
    '<div class="rz" id="rz" title="Resize"></div>' +
  '</div>');

  var $ = function (s) { return root.querySelector(s); };
  var panel = $('#panel'), body = $('#body'), onDragMove = null, onDragUp = null;

  /* drag + resize */
  (function () {
    var hd = $('#hd'), rz = $('#rz'), mode = null, sx, sy, ox, oy, ow, oh;
    function begin(m) {
      return function (e) {
        if (e.target.tagName === 'BUTTON') return;
        var r = panel.getBoundingClientRect();
        mode = m; sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top; ow = r.width; oh = r.height;
        panel.style.right = 'auto'; panel.style.left = ox + 'px'; panel.style.top = oy + 'px';
        panel.style.width = ow + 'px';
        e.preventDefault(); e.stopPropagation();
      };
    }
    hd.addEventListener('mousedown', begin('move'));
    rz.addEventListener('mousedown', begin('size'));
    onDragMove = function (e) {
      if (!mode) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (mode === 'move') {
        panel.style.left = Math.max(0, Math.min(window.innerWidth - 80, ox + dx)) + 'px';
        panel.style.top = Math.max(0, Math.min(window.innerHeight - 40, oy + dy)) + 'px';
      } else {
        var w = Math.max(330, ow - dx), h = Math.max(220, oh + dy);
        panel.style.width = w + 'px';
        panel.style.left = (ox + ow - w) + 'px';
        panel.style.height = h + 'px';
        panel.style.maxHeight = 'none';
      }
    };
    onDragUp = function () { mode = null; };
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragUp);
  })();

  /* Wheel scrolling — many call apps swallow wheel events globally (grid paging,
     scroll-lock), which would leave the panel unscrollable. Handle it ourselves. */
  function onWheel(e) {
    var path = e.composedPath ? e.composedPath() : [];
    if (path.indexOf(host) === -1) return;
    if (e.__rtcW) return;
    e.__rtcW = true;
    var target = null, i, el, ov;
    for (i = 0; i < path.length; i++) {
      el = path[i];
      if (!el || el.nodeType !== 1) continue;
      if (el === host) break;
      if (el.scrollHeight - el.clientHeight > 1) {
        ov = getComputedStyle(el).overflowY;
        if (ov === 'auto' || ov === 'scroll') { target = el; break; }
      }
    }
    if (!target) return;
    var d = e.deltaMode === 1 ? e.deltaY * 16
          : e.deltaMode === 2 ? e.deltaY * target.clientHeight : e.deltaY;
    var before = target.scrollTop;
    target.scrollTop = before + d;
    if (target.scrollTop !== before) e.preventDefault();
    e.stopPropagation();
  }
  window.addEventListener('wheel', onWheel, { capture: true, passive: false });
  panel.addEventListener('wheel', onWheel, { passive: false });

  $('#bmin').addEventListener('click', function () {
    panel.classList.toggle('min');
    this.textContent = panel.classList.contains('min') ? '▢' : '—';
  });
  $('#bcls').addEventListener('click', function () { api.stop(); });
  $('#bcopy').addEventListener('click', function () {
    var b = this;
    dumpAll().then(function (txt) {
      return navigator.clipboard.writeText(txt);
    }).then(function () {
      b.textContent = '✓'; setTimeout(function () { b.textContent = '⧉'; }, 1400);
    }).catch(function () { b.textContent = '✕'; setTimeout(function () { b.textContent = '⧉'; }, 1400); });
  });

  function dumpAll() {
    return Promise.all(PCS.map(function (e, i) {
      return e.pc.getStats().then(function (r) {
        var o = []; r.forEach(function (s) { o.push(s); });
        return { pc: i, connectionState: e.pc.connectionState, iceConnectionState: e.pc.iceConnectionState, stats: o };
      }).catch(function () { return { pc: i, error: 'closed' }; });
    })).then(function (all) {
      return JSON.stringify({
        url: location.href, at: new Date().toISOString(),
        summary: LAST && { down_kbps: LAST.down, up_kbps: LAST.up, rtt_ms: LAST.rtt,
                           loss_pct: LAST.loss, jitter_ms: LAST.jitter, streams_in: LAST.inbound.length,
                           streams_out: LAST.outbound.length },
        history: HIST,
        streamState: { historyKeys: Object.keys(STREAM_HIST), expandedKeys: Object.keys(expanded) },
        peerConnections: all
      }, null, 2);
    });
  }

  /* ================================================================== *
   * 6 — MARKS
   * ================================================================== */
  function sparkPath(vals, w, h, max) {
    var mx = max || Math.max.apply(null, vals) || 1;
    var n = vals.length, step = n > 1 ? w / (n - 1) : 0;
    var pts = vals.map(function (v, i) {
      return [i * step, h - Math.max(0, Math.min(1, v / mx)) * (h - 3) - 1.5];
    });
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    return { line: line, area: line + ' L' + w.toFixed(1) + ' ' + h + ' L0 ' + h + ' Z', pts: pts };
  }

  function miniSpark(vals, color) {
    if (!vals || vals.length < 2) return '<div style="height:18px"></div>';
    var w = 100, h = 18, p = sparkPath(vals, w, h);
    return '<svg class="spark" width="100%" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<path d="' + p.area + '" fill="' + color + '" fill-opacity=".10"/>' +
      '<path d="' + p.line + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>';
  }

  var CH = { W: 366, H: 76 }, showTable = false, hoverIdx = -1;

  function chartHTML() {
    if (HIST.length < 2) {
      return '<div class="chw" style="height:' + (CH.H + 16) + 'px;display:grid;place-items:center;color:' + C.muted + '">collecting…</div>';
    }
    var W = CH.W, H = CH.H;
    var d = HIST.map(function (x) { return x.down; }), u = HIST.map(function (x) { return x.up; });
    var peak = Math.max(Math.max.apply(null, d), Math.max.apply(null, u), 1);
    var mx = peak * 1.15;
    var pd = sparkPath(d, W - 5, H, mx), pu = sparkPath(u, W - 5, H, mx);
    CH.pd = pd; CH.pu = pu;
    return '<div class="chw" id="chw" tabindex="0" role="img" aria-label="Throughput, last ' + HIST.length + ' seconds. Received ' + fmtRate(d[d.length - 1]) + ', sent ' + fmtRate(u[u.length - 1]) + '.">' +
      '<div style="position:absolute;top:7px;right:11px;color:' + C.muted + ';font-size:10px;font-variant-numeric:tabular-nums">peak ' + fmtRate(peak) + '</div>' +
      '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
        '<line x1="0" y1="' + (H - 0.5) + '" x2="' + W + '" y2="' + (H - 0.5) + '" stroke="' + C.axis + '" stroke-width="1"/>' +
        '<path d="' + pd.area + '" fill="' + C.inb + '" fill-opacity=".10"/>' +
        '<path d="' + pu.area + '" fill="' + C.out + '" fill-opacity=".10"/>' +
        '<path d="' + pd.line + '" fill="none" stroke="' + C.inb + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>' +
        '<path d="' + pu.line + '" fill="none" stroke="' + C.out + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>' +
        '<circle cx="' + pd.pts[pd.pts.length - 1][0] + '" cy="' + pd.pts[pd.pts.length - 1][1] + '" r="4" fill="' + C.inb + '" stroke="' + C.surface + '" stroke-width="2"/>' +
        '<circle cx="' + pu.pts[pu.pts.length - 1][0] + '" cy="' + pu.pts[pu.pts.length - 1][1] + '" r="4" fill="' + C.out + '" stroke="' + C.surface + '" stroke-width="2"/>' +
        '<g id="cross"></g>' +
      '</svg><div class="tt" id="tt"></div></div>';
  }

  function tableHTML() {
    var rows = HIST.slice(-14).reverse().map(function (x, i) {
      return '<tr><td>' + (i === 0 ? 'now' : '-' + i + 's') + '</td><td>' + fmtRate(x.down) + '</td><td>' + fmtRate(x.up) + '</td></tr>';
    }).join('');
    return '<div class="tblw"><table class="tbl"><thead><tr><th>Time</th><th>Received</th><th>Sent</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function bars(lvl, color) {
    var h = [5, 8, 10, 12], s = '';
    for (var i = 0; i < 4; i++) s += '<i style="height:' + h[i] + 'px;background:' + (i < lvl ? color : C.axis) + '"></i>';
    return '<span class="bars" aria-hidden="true">' + s + '</span>';
  }

  function icon(kind) {
    return kind === 'audio'
      ? '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.4" y="1.4" width="5.2" height="8.2" rx="2.6" stroke="currentColor" stroke-width="1.4"/><path d="M3 7.6a5 5 0 0 0 10 0M8 12.6V15" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'
      : '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="1.4" y="3.6" width="9" height="8.8" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M11 8l3.6-2.3v4.6L11 8z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  }

  /* ================================================================== *
   * 7 — RENDER (skeleton once, values in place)
   * ================================================================== */
  var expanded = {}, lastSig = null, hoveringChart = false;

  function signature(m) {
    return [m.pcs, showTable,
      m.inbound.map(function (s) { return s.id; }).sort().join(','),
      m.outbound.map(function (s) { return s.id; }).sort().join(','),
      m.pcs ? '' : (m.elements || []).map(function (e) { return e.elTrack; }).join(','),
      (m.zoomMediaChannels || []).map(function (c) { return c.kind + ':' + c.sourceCount; }).join(','),
      !!m.viaTransport, !!m.limit, !!m.localCand].join('|');
  }

  function cardSkeleton(id, kind, color, isMeter) {
    return '<div class="card" data-sid="' + esc(id) + '">' +
      '<div class="crow"><span style="color:' + color + ';display:flex">' + icon(kind) + '</span>' +
      // Seed the title rather than leaving it empty for update() to fill. If the
      // model's stream id and the rendered card ever drift — which happens while
      // streams churn on a pre-join screen — the lookup in update() misses and
      // the card was left showing nothing at all.
      '<span class="cttl" data-u="ttl">' + (kind === 'audio' ? 'Audio' : 'Video') + '</span>' +
      '<span class="cbps" data-u="bps"></span>' +
      '<button class="chev" data-x="' + esc(id) + '" title="All stats for this stream">▾</button></div>' +
      '<div class="meta" data-u="meta"></div>' +
      (isMeter ? '<div class="mtr" style="background:' + fade(color, .22) + '"><i data-u="lvl" style="width:0%;background:' + color + '"></i></div>'
               : '<div data-u="viz"></div>') +
      '<dl class="exp" data-u="exp"></dl></div>';
  }

  function zoomMediaChannelSkeleton(channel) {
    var kind = channel.kind, color = kind === 'audio' ? C.warn : C.inb;
    return '<div class="card" data-zoom-channel="' + esc(kind) + '">' +
      '<div class="crow"><span style="color:' + color + ';display:flex">' + icon(kind) + '</span>' +
      '<span class="cttl">' + (kind === 'audio' ? 'Audio' : 'Video') + ' channel (estimated)</span>' +
      '<span class="cbps" data-u="zoom-rates"></span></div>' +
      '<div class="meta" data-u="zoom-meta"></div></div>';
  }

  function buildSkeleton(m) {
    var h = '';
    h += '<div class="hero"><div><div class="lbl">Round-trip time</div>' +
      '<div style="display:flex;align-items:flex-end;gap:6px"><span class="n" data-u="rtt">—</span><span class="u">ms</span></div></div>' +
      '<div class="q"><div class="qrow" data-u="qbars"></div>' +
      '<div style="color:' + C.muted + ';font-size:10.5px;margin-top:4px" data-u="path"></div></div></div>';

    h += '<div class="tiles">' +
      '<div class="tile"><div class="l"><span class="dot" style="background:' + C.inb + '"></span>Receiving' +
        (m.viaTransport ? ' <span style="color:' + C.muted + '">· all traffic</span>' : '') +
        '</div><div class="v" data-u="down">—</div></div>' +
      '<div class="tile"><div class="l"><span class="dot" style="background:' + C.out + '"></span>Sending' +
        (m.viaTransport ? ' <span style="color:' + C.muted + '">· all traffic</span>' : '') +
        '</div><div class="v" data-u="up">—</div></div>' +
      '<div class="tile"><div class="l">Packet loss <span data-u="lossst"></span></div><div class="v" data-u="loss">—</div></div>' +
      '<div class="tile"><div class="l">Jitter <span data-u="jitst"></span></div><div class="v" data-u="jit">—</div></div></div>';

    h += '<div data-u="limit"></div>';

    if (m.viaTransport) {
      h += '<div class="note"><span style="color:' + C.warn + '">ⓘ</span><div>' +
        '<b>This app tunnels media through data channels.</b><br>' +
        'It encodes audio and video itself and ships the bytes over DataChannels instead of ' +
        'sending RTP tracks — Zoom\'s web client works this way. ' +
        (m.zoomMediaChannels && m.zoomMediaChannels.length
          ? 'There are no RTP participant, codec, loss or frame details. The estimated rows below ' +
            'are Zoom-labelled channel subtotals across all participants; the figures above remain total wire traffic.'
          : 'There is no RTP stream detail to read, so the figures above are total traffic on the wire.') +
        '</div></div>';
    }

    if (!m.pcs) {
      h += '<div class="note"><span style="color:' + C.warn + '">⚠</span><div><b>No peer connection captured yet.</b><br>' +
        'The call was already running when the monitor started, so RTP-level stats are not reachable. ' +
        'Hit Rescan, or reload the page with the monitor installed. Device-level detail is shown below meanwhile.' +
        '<br><button id="brescan">Rescan for connections</button></div></div>';
    }

    h += '<div class="sec"><div class="lg"><span><i style="background:' + C.inb + '"></i>Received</span>' +
      '<span><i style="background:' + C.out + '"></i>Sent</span>' +
      '<button class="lgbtn" id="btbl">' + (showTable ? 'chart' : 'table') + '</button></div>' +
      '<div data-u="chart"></div></div>';

    var outs = m.outbound.slice(), remoteEls = (m.elements || []).filter(function (e) { return !e.local; });
    var localEls = (m.elements || []).filter(function (e) { return e.local; });

    if (outs.length || (!m.pcs && localEls.length)) {
      h += '<div class="sec"><div class="sech">Sending <span class="c">' + (outs.length || localEls.length) + '</span><span class="sp"></span></div>';
      h += outs.length
        ? outs.map(function (s) { return cardSkeleton(s.id, s.kind, C.out, s.kind === 'audio'); }).join('')
        : localEls.map(function (e) { return cardSkeleton('el:' + e.elTrack, e.kind, C.out, false); }).join('');
      h += '</div>';
    }
    if (m.inbound.length || remoteEls.length) {
      h += '<div class="sec"><div class="sech">Receiving <span class="c">' + (m.inbound.length || remoteEls.length) + '</span><span class="sp"></span></div>';
      h += m.inbound.length
        ? m.inbound.map(function (s) { return cardSkeleton(s.id, s.kind, C.inb, s.kind === 'audio'); }).join('')
        : remoteEls.map(function (e) { return cardSkeleton('el:' + e.elTrack, e.kind, C.inb, false); }).join('');
      h += '</div>';
    }

    if (m.zoomMediaChannels && m.zoomMediaChannels.length) {
      h += '<div class="sec"><div class="sech">Zoom media channels <span class="c">' +
        m.zoomMediaChannels.length + '</span><span class="sp"></span></div>' +
        m.zoomMediaChannels.map(zoomMediaChannelSkeleton).join('') + '</div>';
    }

    if (m.pcs) h += '<div class="sec"><div class="sech">Transport<span class="sp"></span></div>' +
      '<div class="card"><div class="meta" style="margin-top:0" data-u="transport"></div></div></div>';

    body.innerHTML = trust(h);
    wire();
  }

  function set(sel, html) { var e = root.querySelector(sel); if (e && e.innerHTML !== html) e.innerHTML = trust(html); }

  function meetNumericMid(value) {
    if (typeof value === 'number') {
      return isFinite(value) && value >= 0 && Math.floor(value) === value ? value : null;
    }
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
    var parsed = Number(value);
    return isFinite(parsed) && parsed >= 0 && Math.floor(parsed) === parsed ? parsed : null;
  }

  /* Meet does not attach its remote <audio> sinks to participant tiles, so an
     exact audio-track -> DOM-name lookup can legitimately have no result. As a
     deliberately approximate fallback, pair Meet's receiver slots by numeric
     media-section rank — but only when one peer connection presents a complete
     one-to-one set of audio slots and exactly named remote video slots. Any
     missing track/MID, duplicate conflict, or count mismatch fails closed. */
  function meetLikelyInboundAudioName(stream, m) {
    if (location.hostname !== 'meet.google.com' || stream.dir !== 'in' ||
        stream.kind !== 'audio' || stream.pcKey === null || stream.pcKey === undefined) return null;

    function remoteTrackName(track, kind) {
      if (!track) return { name: null, conflict: true };
      var matches = (m.elements || []).filter(function (e) {
        return e.elTrack === track && e.kind === kind;
      });
      var names = [];
      for (var i = 0; i < matches.length; i++) {
        if (matches[i].local) return { name: null, conflict: true };
        if (matches[i].name && names.indexOf(matches[i].name) < 0) names.push(matches[i].name);
      }
      return { name: names.length === 1 ? names[0] : null, conflict: names.length > 1 };
    }

    function slots(kind, namesRequired) {
      var byMid = new Map(), byTrack = new Map(), byName = new Map(), rows = (m.inbound || []).filter(function (row) {
        return row.pcKey === stream.pcKey && row.dir === 'in' && row.kind === kind;
      });
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i], mid = meetNumericMid(row.mid), track = row.track;
        if (mid === null || !track) return null;
        var resolved = remoteTrackName(track, kind);
        if (resolved.conflict || (namesRequired && !resolved.name)) return null;
        var priorMid = byMid.get(mid), priorTrack = byTrack.get(track);
        if ((priorMid && (priorMid.track !== track || priorMid.name !== resolved.name)) ||
            (priorTrack && priorTrack.mid !== mid)) return null;
        if (!priorMid) {
          var priorName = namesRequired && resolved.name ? byName.get(resolved.name) : null;
          if (priorName && (priorName.mid !== mid || priorName.track !== track)) return null;
          var slot = { mid: mid, track: track, name: resolved.name };
          byMid.set(mid, slot); byTrack.set(track, slot);
          if (namesRequired && resolved.name) byName.set(resolved.name, slot);
        }
      }
      return Array.from(byMid.values()).sort(function (a, b) { return a.mid - b.mid; });
    }

    var audio = slots('audio', false), video = slots('video', true);
    if (!audio || !video || !audio.length || audio.length !== video.length) return null;
    var targetMid = meetNumericMid(stream.mid);
    if (targetMid === null || !stream.track) return null;
    for (var i = 0; i < audio.length; i++) {
      if (audio[i].name && audio[i].name !== video[i].name) return null;
    }
    for (var i = 0; i < audio.length; i++) {
      if (audio[i].mid !== targetMid || audio[i].track !== stream.track) continue;
      return video[i].name;
    }
    return null;
  }

  function updateCard(el, s, m, color) {
    var kind = s.kind || 'video';
    var linked = s.track ? (m.elements || []).filter(function (e) { return e.elTrack === s.track; })[0] : null;
    /* Outgoing streams often cannot be matched by track at all: Meet pipes the
       camera through its effects stage, so the track it sends is a different
       object from the one its preview element renders. When exactly one local
       participant name exists it is unambiguously the same person. The named
       preview may be video even when the outgoing card is audio (Airion keeps
       its audio element outside the participant tile). */
    if (!linked && s.dir === 'out') {
      var locals = (m.elements || []).filter(function (e) { return e.local && e.kind === kind && e.name; });
      var names = {};
      locals.forEach(function (e) { names[e.name] = e; });
      if (Object.keys(names).length === 1) linked = names[Object.keys(names)[0]];
      if (!linked) {
        names = {};
        (m.elements || []).forEach(function (e) { if (e.local && e.name) names[e.name] = e; });
        if (Object.keys(names).length === 1) linked = names[Object.keys(names)[0]];
      }
    }
    var name = linked && linked.name;
    var likelyName = !name ? meetLikelyInboundAudioName(s, m) : null;
    var displayName = name || (likelyName ? likelyName + ' (likely)' : null);
    var q = el.querySelector('[data-u=ttl]');
    // no name found in the DOM: tag the card with the last 4 of the SSRC so the
    // cards stay tellable apart instead of all reading "Video"
    q.textContent = displayName || ((kind === 'audio' ? 'Audio' : 'Video') +
      (s.ssrc ? ' · ' + String(s.ssrc).slice(-4) : ''));
    q.title = likelyName
      ? likelyName + ' (likely) · approximate Meet media-slot match · ssrc ' + s.ssrc +
        (s.track ? ' · track ' + s.track : '')
      : (name ? name + ' · ' : '') + 'ssrc ' + s.ssrc + (s.track ? ' · track ' + s.track : '');
    el.querySelector('[data-u=bps]').textContent = fmtRate(s.kbps);

    var meta = [];
    if (s.codec && s.codec.name) meta.push('<b>' + esc(String(s.codec.name).toUpperCase()) + '</b>');
    if (kind === 'video') {
      if (s.w && s.h) meta.push('<b>' + s.w + '×' + s.h + '</b>');
      if (s.fps !== null && s.fps !== undefined && isFinite(s.fps)) meta.push('<b>' + Math.round(s.fps) + '</b> fps');
    } else {
      if (s.codec && s.codec.clock) meta.push('<b>' + (s.codec.clock / 1000) + '</b> kHz');
      if (s.codec && s.codec.channels) meta.push(s.codec.channels > 1 ? 'stereo' : 'mono');
    }
    if (s.dir === 'in') {
      if (s.lossPct !== null) meta.push('loss <b>' + fmtPct(s.lossPct) + '</b>');
      if (s.jitter !== null) meta.push('jitter <b>' + fmtMs(s.jitter, 1) + '</b>');
      if (s.framesDropped) meta.push('dropped <b>' + s.framesDropped + '</b>');
      if (s.freezeCount) meta.push('freezes <b>' + s.freezeCount + '</b>');
    } else {
      if (s.fraction !== null && s.fraction !== undefined) meta.push('loss <b>' + fmtPct(s.fraction) + '</b>');
      if (s.rtt !== null && s.rtt !== undefined) meta.push('rtt <b>' + fmtMs(s.rtt) + '</b>');
      if (s.rid) meta.push('layer <b>' + esc(s.rid) + '</b>');
      /* Simulcast without rids. Meet sends three encodings of one track and sets
         no `rid`, so the idle layers used to read as three dead video streams.
         Streams sharing a track id are encodings of the same source: number them
         and say plainly that the quiet ones are idle rather than broken. */
      if (kind === 'video' && s.track) {
        var sibs = (m.outbound || []).filter(function (o) { return o.track === s.track; });
        if (sibs.length > 1) {
          if (!s.rid) meta.push('layer <b>' + (sibs.indexOf(s) + 1) + '/' + sibs.length + '</b>');
          if (!s.kbps) meta.push('<span class="pill">idle</span>');
        }
      }
      if (s.scalability && s.scalability !== 'L1T1') meta.push('svc <b>' + esc(s.scalability) + '</b>');
      if (s.limit) meta.push('<span class="pill" style="border-color:rgba(250,178,25,.5);color:' + C.warn + '">⚠ ' + esc(s.limit) + '-limited</span>');
    }
    set('[data-sid="' + CSS.escape(s.id) + '"] [data-u=meta]', meta.join(SEP));

    var lvlEl = el.querySelector('[data-u=lvl]');
    if (lvlEl) {
      var lvl = s.dir === 'out' ? (m.localAudio || 0)
        : (s.audioLevel !== null && s.audioLevel !== undefined ? s.audioLevel : (m.levels[s.track] || 0));
      var pct = Math.min(100, Math.round(Math.sqrt(Math.max(0, lvl)) * 100));
      lvlEl.style.width = pct + '%';
      lvlEl.style.background = pct > 92 ? C.warn : color;
      lvlEl.parentNode.title = 'Audio level ' + pct + '%';
    }
    var viz = el.querySelector('[data-u=viz]');
    if (viz) viz.innerHTML = trust(miniSpark(STREAM_HIST[s.id], color));

    var dl = el.querySelector('[data-u=exp]');
    dl.classList.toggle('on', !!expanded[s.id]);
    if (expanded[s.id]) {
      var top = dl.scrollTop, raw = s.raw || {}, out = '';
      Object.keys(raw).sort().forEach(function (k) {
        var v = raw[k];
        if (v === null || v === undefined || typeof v === 'object') return;
        out += '<dt>' + esc(k) + '</dt><dd>' + esc(typeof v === 'number' ? Math.round(v * 1000) / 1000 : v) + '</dd>';
      });
      if (linked) {
        out += '<dt style="color:' + C.ink2 + ';padding-top:4px">device</dt><dd></dd>';
        ['label', 'state', 'enabled', 'trackMuted', 'settingsFps', 'renderFps', 'dropped',
         'sampleRate', 'channels', 'ec', 'ns', 'agc'].forEach(function (k) {
          if (linked[k] === undefined || linked[k] === null) return;
          out += '<dt>' + k + '</dt><dd>' + esc(typeof linked[k] === 'number' ? Math.round(linked[k] * 100) / 100 : linked[k]) + '</dd>';
        });
      }
      if (dl.innerHTML !== out) { dl.innerHTML = trust(out); dl.scrollTop = top; }
    }
  }

  function updateElementCard(el, e, color) {
    el.querySelector('[data-u=ttl]').textContent = e.name || e.label || (e.kind === 'audio' ? 'Audio' : 'Video');
    el.querySelector('[data-u=bps]').textContent = e.state;
    el.querySelector('[data-u=bps]').style.color = C.muted;
    var meta = [];
    if (e.w && e.h) meta.push('<b>' + e.w + '×' + e.h + '</b>');
    if (e.renderFps) meta.push('<b>' + Math.round(e.renderFps) + '</b> fps rendered');
    else if (e.settingsFps) meta.push('<b>' + Math.round(e.settingsFps) + '</b> fps');
    if (e.dropped) meta.push('dropped <b>' + e.dropped + '</b>');
    if (e.sampleRate) meta.push('<b>' + (e.sampleRate / 1000) + '</b> kHz');
    if (e.channels) meta.push(e.channels > 1 ? 'stereo' : 'mono');
    if (e.ec) meta.push('echo-cancel');
    if (e.ns) meta.push('noise-suppress');
    if (e.trackMuted) meta.push('<span class="pill" style="color:' + C.warn + '">muted at source</span>');
    if (!e.enabled) meta.push('<span class="pill" style="color:' + C.warn + '">disabled</span>');
    el.querySelector('[data-u=meta]').innerHTML = trust(meta.join(SEP));
    var dl = el.querySelector('[data-u=exp]');
    dl.classList.toggle('on', !!expanded['el:' + e.elTrack]);
    if (expanded['el:' + e.elTrack]) {
      var out = '';
      Object.keys(e).forEach(function (k) {
        if (e[k] === null || e[k] === undefined || typeof e[k] === 'object') return;
        out += '<dt>' + esc(k) + '</dt><dd>' + esc(typeof e[k] === 'number' ? Math.round(e[k] * 100) / 100 : e[k]) + '</dd>';
      });
      if (dl.innerHTML !== out) dl.innerHTML = trust(out);
    }
  }

  function updateZoomMediaChannel(channel) {
    var el = root.querySelector('[data-zoom-channel="' + CSS.escape(channel.kind) + '"]');
    if (!el) return;
    var rates = el.querySelector('[data-u=zoom-rates]');
    function channelRate(value) {
      return value === null || value === undefined ? '—' : (value > 0 ? fmtRate(value) : 'idle');
    }
    if (rates) rates.innerHTML = trust(
      '<span style="color:' + C.inb + '">↓</span> ' + channelRate(channel.inKbps) +
      ' ' + SEP + ' <span style="color:' + C.out + '">↑</span> ' + channelRate(channel.outKbps));
    var meta = el.querySelector('[data-u=zoom-meta]');
    if (meta) meta.innerHTML = trust('all participants' + SEP +
      channel.sourceCount + ' channel' + (channel.sourceCount === 1 ? '' : 's') + ' combined');
    el.title = 'Estimated from Zoom Web Client media-channel byte counters; ' +
      'not a participant-level RTP stream.';
  }

  function update(m) {
    var q = quality(m);
    $('#hdot').style.background = q.color;
    $('#hsub').textContent = m.pcs ? (m.pcs + ' connection' + (m.pcs > 1 ? 's' : '')) : 'scanning…';

    var rttEl = root.querySelector('[data-u=rtt]');
    if (rttEl) rttEl.textContent = m.rtt === null ? '—' : Math.round(m.rtt);
    set('[data-u=qbars]', bars(q.lvl, q.color) + '<span class="qlab" style="color:' + q.color + '">' + q.label + '</span>');
    set('[data-u=path]', m.localCand
      ? esc(m.localCand.type === 'relay' ? 'via TURN relay' : m.localCand.type === 'host' ? 'direct · LAN' : 'direct · STUN') +
        (m.localCand.proto ? ' · ' + esc(String(m.localCand.proto).toUpperCase()) : '')
      : '');

    var dEl = root.querySelector('[data-u=down]'); if (dEl) dEl.textContent = fmtRate(m.down);
    var uEl = root.querySelector('[data-u=up]'); if (uEl) uEl.textContent = fmtRate(m.up);
    var lEl = root.querySelector('[data-u=loss]'); if (lEl) lEl.textContent = fmtPct(m.loss);
    var jEl = root.querySelector('[data-u=jit]'); if (jEl) jEl.textContent = fmtMs(m.jitter, 1);
    var ls = m.loss === null ? null : (m.loss < 1 ? [C.good, 'ok'] : m.loss < 3 ? [C.warn, 'elevated'] : [C.crit, 'high']);
    var js = m.jitter === null ? null : (m.jitter < 30 ? [C.good, 'ok'] : m.jitter < 60 ? [C.warn, 'elevated'] : [C.crit, 'high']);
    set('[data-u=lossst]', ls ? '<span style="color:' + ls[0] + '">· ' + ls[1] + '</span>' : '');
    set('[data-u=jitst]', js ? '<span style="color:' + js[0] + '">· ' + js[1] + '</span>' : '');

    set('[data-u=limit]', m.limit
      ? '<div class="note"><span style="color:' + C.warn + '">⚠</span><div><b>Outgoing quality limited by ' + esc(m.limit) + '.</b><br>' +
        (m.limit === 'bandwidth' ? 'Your uplink can\'t carry the requested bitrate — the encoder is shedding resolution or framerate.'
         : m.limit === 'cpu' ? 'The encoder can\'t keep up. Close other apps or send a lower resolution.'
         : 'Bandwidth and CPU are both constraining the encoder.') + '</div></div>'
      : '');

    if (!hoveringChart) {
      var ch = root.querySelector('[data-u=chart]');
      if (ch) { ch.innerHTML = trust(showTable ? tableHTML() : chartHTML()); wireChart(); }
    }

    m.inbound.concat(m.outbound).forEach(function (s) {
      var el = root.querySelector('[data-sid="' + CSS.escape(s.id) + '"]');
      if (el) updateCard(el, s, m, s.dir === 'in' ? C.inb : C.out);
    });
    if (!m.pcs) {
      (m.elements || []).forEach(function (e) {
        var el = root.querySelector('[data-sid="' + CSS.escape('el:' + e.elTrack) + '"]');
        if (el) updateElementCard(el, e, e.local ? C.out : C.inb);
      });
    }
    (m.zoomMediaChannels || []).forEach(updateZoomMediaChannel);

    set('[data-u=transport]', !m.pcs ? '' : [
      m.localCand ? 'local <b>' + esc(m.localCand.type) + '</b>' + (m.localCand.net ? ' (' + esc(m.localCand.net) + ')' : '') : '',
      m.remoteCand ? 'remote <b>' + esc(m.remoteCand.type) + '</b>' : '',
      m.avail !== null ? 'uplink estimate <b>' + fmtRate(m.avail) + '</b>' : '',
      (m.tIn !== null || m.tOut !== null)
        ? 'wire total <b>↓ ' + fmtRate(m.tIn) + ' ↑ ' + fmtRate(m.tOut) + '</b>' : '',
      m.dtls ? 'dtls <b>' + esc(m.dtls) + '</b>' : '',
      m.states.length ? 'state <b>' + esc(m.states.join(', ')) + '</b>' : ''
    ].filter(Boolean).join(SEP));
  }

  function render(m) {
    var sig = signature(m);
    if (sig !== lastSig) {
      lastSig = sig;
      var top = body.scrollTop;
      buildSkeleton(m);
      body.scrollTop = top;
    }
    update(m);
  }

  function wire() {
    var t = root.querySelector('#btbl');
    if (t) t.addEventListener('click', function () { showTable = !showTable; lastSig = null; if (LAST) render(LAST); });
    var rs = root.querySelector('#brescan');
    if (rs) rs.addEventListener('click', function () {
      var n = discover();
      this.textContent = n ? 'Found ' + n + ' — reading…' : 'Nothing found — reload the page with the monitor on';
    });
    root.querySelectorAll('.chev').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-x');
        expanded[id] = !expanded[id];
        b.textContent = expanded[id] ? '▴' : '▾';
        if (LAST) update(LAST);
      });
    });
    wireChart();
  }

  function wireChart() {
    var chw = root.querySelector('#chw');
    if (!chw) return;
    var tt = root.querySelector('#tt'), cross = root.querySelector('#cross');
    function show(i) {
      if (i < 0 || i >= HIST.length || !CH.pd) return;
      hoverIdx = i;
      var d = HIST[i], x = CH.pd.pts[i][0];
      cross.innerHTML = trust(
        '<line x1="' + x + '" y1="0" x2="' + x + '" y2="' + CH.H + '" stroke="' + C.axis + '" stroke-width="1"/>' +
        '<circle cx="' + x + '" cy="' + CH.pd.pts[i][1] + '" r="4" fill="' + C.inb + '" stroke="' + C.surface + '" stroke-width="2"/>' +
        '<circle cx="' + x + '" cy="' + CH.pu.pts[i][1] + '" r="4" fill="' + C.out + '" stroke="' + C.surface + '" stroke-width="2"/>');
      tt.innerHTML = trust('<div style="color:' + C.muted + ';margin-bottom:2px">' + (HIST.length - 1 - i) + 's ago</div>' +
        '<div class="r"><span class="dot" style="background:' + C.inb + '"></span>Received <b>' + fmtRate(d.down) + '</b></div>' +
        '<div class="r"><span class="dot" style="background:' + C.out + '"></span>Sent <b>' + fmtRate(d.up) + '</b></div>');
      tt.style.display = 'block';
      var w = chw.clientWidth, px = (x / (CH.W - 5)) * (w - 20) + 10;
      tt.style.left = Math.max(4, Math.min(w - 132, px - 62)) + 'px';
      tt.style.top = '6px';
    }
    function clear() { tt.style.display = 'none'; cross.innerHTML = trust(''); hoverIdx = -1; }
    chw.addEventListener('mouseenter', function () { hoveringChart = true; });
    chw.addEventListener('mousemove', function (e) {
      var r = chw.getBoundingClientRect();
      var f = (e.clientX - r.left - 10) / Math.max(1, r.width - 20);
      show(Math.round(Math.max(0, Math.min(1, f)) * (HIST.length - 1)));
    });
    chw.addEventListener('mouseleave', function () { hoveringChart = false; clear(); });
    chw.addEventListener('focus', function () { hoveringChart = true; show(HIST.length - 1); });
    chw.addEventListener('blur', function () { hoveringChart = false; clear(); });
    chw.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { show(Math.max(0, (hoverIdx < 0 ? HIST.length - 1 : hoverIdx) - 1)); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { show(Math.min(HIST.length - 1, (hoverIdx < 0 ? 0 : hoverIdx) + 1)); e.preventDefault(); }
      else if (e.key === 'Escape') { chw.blur(); }
    });
  }

  /* ================================================================== *
   * 8 — LOOP
   * ================================================================== */
  var timer = null, huntTimer = null, waitTimer = null, zoomWaitTimer = null,
    zoomWaiting = false, busy = false;
  function loop() {
    if (busy) return;
    busy = true;
    tick().then(function (m) {
      // Minimising hides paint work only; collection must continue so the
      // debugger harvest/model does not go stale while Meet's Join is exposed.
      if (!panel.classList.contains('min')) render(m);
    }).catch(function (e) { console.warn('[RTC Monitor]', e); })
      .then(function () { busy = false; });
  }

  var isTop = (function () { try { return window.top === window.self; } catch (e) { return false; } })();
  function wakeForCapturedConnection() {
    if (!zoomWaiting || !PCS.length || !host) return;
    zoomWaiting = false;
    if (zoomWaitTimer) clearTimeout(zoomWaitTimer);
    zoomWaitTimer = null;
    host.style.display = '';
    run();
  }

  function run() {
    loop();
    timer = setInterval(loop, 1000);
    var tries = 0;
    huntTimer = setInterval(function () {
      if (PCS.length || ++tries > 12) { clearInterval(huntTimer); huntTimer = null; }
      else discover();
    }, 1500);
  }

  var api = {
    start: function () {
      if (timer || zoomWaiting) return;
      discover();
      /* Zoom's outer PWA shell and its media iframe both receive monitor.js.
         Do not show an empty duplicate panel in either realm. A participant may
         remain on Zoom's preview screen for a while, so keep the document-start
         subscription alive (but hidden) for a bounded 150 seconds. */
      if (IS_ZOOM_WEBCLIENT_REALM && !PCS.length) {
        host.style.display = 'none';
        zoomWaiting = true;
        zoomWaitTimer = setTimeout(function () {
          zoomWaitTimer = null;
          if (zoomWaiting) { zoomWaiting = false; api.stop(); }
        }, 150000);
        return;
      }
      // Sub-frames: the script is injected into every frame so embedded calls
      // (a Meet/Jitsi widget inside another page) are covered. A frame with no
      // media of its own shows nothing and removes itself.
      if (!isTop && !PCS.length) {
        host.style.display = 'none';
        var n = 0;
        waitTimer = setInterval(function () {
          discover();
          if (PCS.length) { clearInterval(waitTimer); waitTimer = null; host.style.display = ''; run(); }
          else if (++n > 6) { clearInterval(waitTimer); waitTimer = null; api.stop(); }
        }, 1200);
        return;
      }
      run();
    },
    stop: function () {
      if (timer) clearInterval(timer);
      if (huntTimer) clearInterval(huntTimer);
      if (waitTimer) clearInterval(waitTimer);
      if (zoomWaitTimer) clearTimeout(zoomWaitTimer);
      timer = null;
      huntTimer = null;
      waitTimer = null;
      zoomWaitTimer = null;
      zoomWaiting = false;
      if (earlyCaptureListening) {
        try { window.removeEventListener(EARLY_CAPTURE_EVENT, onEarlyCapturedConnection); } catch (e) {}
        earlyCaptureListening = false;
      }
      try { window.removeEventListener('wheel', onWheel, { capture: true }); } catch (e) {}
      try { if (onDragMove) window.removeEventListener('mousemove', onDragMove); } catch (e) {}
      try { if (onDragUp) window.removeEventListener('mouseup', onDragUp); } catch (e) {}
      host.remove();
      try { if (window.RTCPeerConnection === WrappedPC) window.RTCPeerConnection = NativeRTCPC || NativePC; } catch (e) {}
      try {
        if (NativeWebkitPC && window.webkitRTCPeerConnection === WrappedPC) window.webkitRTCPeerConnection = NativeWebkitPC;
      } catch (e) {}
      for (var i = PATCHED_PROTO.length - 1; i >= 0; i--) {
        try {
          var patch = PATCHED_PROTO[i];
          var current = Object.getOwnPropertyDescriptor(NativePC.prototype, patch.key);
          var installed = patch.installed;
          var owned = current && installed &&
            (Object.prototype.hasOwnProperty.call(installed, 'value')
              ? current.value === installed.value
              : current.get === installed.get && current.set === installed.set);
          if (!owned) continue;
          if (patch.descriptor) Object.defineProperty(NativePC.prototype, patch.key, patch.descriptor);
          else delete NativePC.prototype[patch.key];
        } catch (e) {}
      }
      PATCHED_PROTO = [];
      try { delete window[NS]; } catch (e) { window[NS] = undefined; }
    },
    toggle: function () { panel.style.display = panel.style.display === 'none' ? '' : 'none'; },
    /* Adopt peer connections found from outside the page.
       Google Meet defines both `window.RTCPeerConnection` and its prototype
       methods as non-writable AND non-configurable, and keeps its instances in
       Closure-compiled closures — so the constructor wrap, the prototype hooks
       and the deep scan all come up empty there, whatever the injection timing.
       The extension's debugger path can still reach them through DevTools'
       queryObjects(), which reads live instances off the heap, and hands them
       here. Accepts one connection or an array. */
    adopt: function (input) {
      var list = (input && typeof input.length === 'number' && typeof input.getStats !== 'function')
        ? input : [input];
      var added = 0;
      for (var i = 0; i < list.length; i++) {
        var pc = list[i];
        if (pc && typeof pc.getStats === 'function' && register(pc)) added++;
      }
      if (added) { if (!timer) run(); else loop(); }
      return added;
    },
    rescan: discover,
    // Share the monitor's conservative Meet audio-slot naming with dashboards.
    meetAudioName: function (stream, names) {
      if (!LAST) return null;
      var model = LAST;
      if (names) model = Object.assign({}, LAST, {
        elements: (LAST.elements || []).map(function (element) {
          return names[element.elTrack] ? Object.assign({}, element, names[element.elTrack]) : element;
        })
      });
      return meetLikelyInboundAudioName(stream, model);
    },
    dump: dumpAll,
    get model() { return LAST; }
  };
  window[NS] = api;
  api.start();
  console.log('%c RTC Stream Monitor ', 'background:#3987e5;color:#fff;border-radius:3px;padding:1px 4px',
    'running · window.' + NS + ' → { rescan(), dump(), stop() }');
})();
