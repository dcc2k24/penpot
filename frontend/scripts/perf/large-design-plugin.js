const PARAMS = __PARAMS__;

(async () => {
  try {
    // ---------------------------------------------------------------
    // Config and seeded random helpers
    // ---------------------------------------------------------------
    const DEFAULTS = {
      screenPages: 4,
      screensPerPage: 30,
      tableRows: 12,
      seed: 42,
      singlePageScreens: 0,
      appendScreens: 50,
      layoutCapacity: 300,
    };
    const params = PARAMS && typeof PARAMS === "object" ? PARAMS : {};

    const numberOr = (value, fallback) =>
      typeof value === "number" && Number.isFinite(value) ? value : fallback;

    const config = {
      screenPages: Math.max(0, Math.floor(numberOr(params.screenPages, DEFAULTS.screenPages))),
      screensPerPage: Math.max(0, Math.floor(numberOr(params.screensPerPage, DEFAULTS.screensPerPage))),
      tableRows: Math.max(0, Math.floor(numberOr(params.tableRows, DEFAULTS.tableRows))),
      seed: Math.floor(numberOr(params.seed, DEFAULTS.seed)),
      singlePageScreens: Math.max(0, Math.floor(numberOr(params.singlePageScreens, DEFAULTS.singlePageScreens))),
      appendScreens: Math.max(0, Math.floor(numberOr(params.appendScreens, DEFAULTS.appendScreens))),
      layoutCapacity: Math.max(1, Math.floor(numberOr(params.layoutCapacity, DEFAULTS.layoutCapacity))),
    };

    // "full" (default), "init", "append", "count" or "verify-theme". Checked at the Main flow.
    const mode = typeof params.mode === "string" ? params.mode : "full";

    // mulberry32: small deterministic PRNG. Returns floats in [0, 1).
    const mulberry32 = (seedValue) => {
      let state = seedValue >>> 0;
      return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };

    // Switchable random streams. The main stream keeps the original sequence
    // of calls; new content draws from its own streams so old output stays put.
    const mainRandom = mulberry32(config.seed);
    let activeRandom = mainRandom;
    const rand = () => activeRandom();
    const extraRandom = mulberry32((config.seed ^ 0x5bd1e995) >>> 0);
    const enterpriseRandom = mulberry32((config.seed + 0x9e3779b9) >>> 0);
    const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
    const pick = (items) => items[Math.floor(rand() * items.length)];
    const chance = (probability) => rand() < probability;

    // Runs fn with `stream` as the active random source, then restores the previous one.
    function withStream(stream, fn) {
      const prev = activeRandom;
      activeRandom = stream;
      try {
        return fn();
      } finally {
        activeRandom = prev;
      }
    }

    // With the default flag off, appendChild puts a child at the bottom of the
    // z-order and `children` comes back reversed. Turning it on makes later
    // children paint on top and keeps `children` in the order they were added.
    attempt(() => {
      penpot.flags.naturalChildOrdering = true;
    });

    // ---------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------
    const PALETTE = {
      text: "#111827",
      muted: "#6B7280",
      border: "#E5E7EB",
      white: "#FFFFFF",
      primary: "#4F46E5",
      success: "#16A34A",
      warning: "#D97706",
      danger: "#DC2626",
      sidebar: "#0F172A",
      sidebarText: "#CBD5E1",
      inputBorder: "#D1D5DB",
      toggleOff: "#D1D5DB",
      sidebarActive: "#1E293B",
      primaryTint: "#E0E7FF",
      successTint: "#DCFCE7",
      warningTint: "#FEF3C7",
      dangerTint: "#FEE2E2",
    };

    // Themed mode (params.themed === true): design-token sets and themes.
    const THEMED = params.themed === true;
    // Set to true once the tokens exist (setupThemeTokens or loadThemeTokens).
    let themingOn = false;
    // True while screens are built: shapes get their token bindings queued.
    // Tokens are created only at the end (bindAllPages). Once tokens exist,
    // every instance() call makes Penpot re-apply every token on every page.
    let collecting = false;
    const THEME_NAMES = ["Light", "Dark", "Mid"];
    const THEME_GROUP = "Mode";
    // Token name -> [Light, Dark, Mid]. Light values equal the PALETTE colours, so a Light file looks the same as an unthemed one.
    const THEME_COLORS = {
      "color.text": ["#111827", "#F9FAFB", "#0F172A"],
      "color.text-muted": ["#6B7280", "#9CA3AF", "#334155"],
      "color.on-primary": ["#FFFFFF", "#FFFFFF", "#F0FDFA"],
      "color.primary": ["#4F46E5", "#818CF8", "#0F766E"],
      "color.success": ["#16A34A", "#4ADE80", "#166534"],
      "color.warning": ["#D97706", "#FBBF24", "#92400E"],
      "color.danger": ["#DC2626", "#F87171", "#991B1B"],
      "color.sidebar-text": ["#CBD5E1", "#94A3B8", "#E2E8F0"],
      "color.surface": ["#FFFFFF", "#1F2937", "#CBD5E1"],
      "color.inverse-surface": ["#111827", "#F9FAFB", "#1E293B"],
      "color.border": ["#E5E7EB", "#374151", "#94A3B8"],
      "color.border-strong": ["#D1D5DB", "#4B5563", "#64748B"],
      "color.primary-tint": ["#E0E7FF", "#312E81", "#99F6E4"],
      "color.success-tint": ["#DCFCE7", "#14532D", "#BBF7D0"],
      "color.warning-tint": ["#FEF3C7", "#78350F", "#FDE68A"],
      "color.danger-tint": ["#FEE2E2", "#7F1D1D", "#FECACA"],
      "color.sidebar": ["#0F172A", "#030712", "#334155"],
      "color.sidebar-active": ["#1E293B", "#111827", "#475569"],
      "color.surface-muted": ["#F3F4F6", "#111827", "#94A3B8"],
      "color.surface-subtle": ["#F9FAFB", "#0B1220", "#A3B1C2"],
    };
    // Same value in every theme.
    const THEME_RADII = { "radius.sm": "4", "radius.md": "8", "radius.lg": "12", "radius.xl": "16" };
    const RADIUS_TOKEN = { 4: "radius.sm", 8: "radius.md", 12: "radius.lg", 16: "radius.xl" };
    const RADIUS_ATTRS = ["borderRadiusTopLeft", "borderRadiusTopRight", "borderRadiusBottomRight", "borderRadiusBottomLeft"];
    // Which token a hex colour maps to, by where the colour is used. Keys are upper-case hex.
    const COLOR_ROLE = {
      text: {
        "#111827": "color.text", "#6B7280": "color.text-muted", "#FFFFFF": "color.on-primary",
        "#4F46E5": "color.primary", "#16A34A": "color.success", "#D97706": "color.warning",
        "#DC2626": "color.danger", "#CBD5E1": "color.sidebar-text",
      },
      fill: {
        "#FFFFFF": "color.surface", "#111827": "color.inverse-surface", "#E5E7EB": "color.border",
        "#D1D5DB": "color.border-strong", "#4F46E5": "color.primary", "#16A34A": "color.success",
        "#D97706": "color.warning", "#DC2626": "color.danger", "#E0E7FF": "color.primary-tint",
        "#DCFCE7": "color.success-tint", "#FEF3C7": "color.warning-tint", "#FEE2E2": "color.danger-tint",
        "#0F172A": "color.sidebar", "#1E293B": "color.sidebar-active", "#F3F4F6": "color.surface-muted",
        "#F9FAFB": "color.surface-subtle",
      },
      stroke: { "#E5E7EB": "color.border", "#D1D5DB": "color.border-strong", "#4F46E5": "color.primary" },
    };

    const SCREEN_W = 1440;
    // Tall enough to show the dashboard and users tables in full, like a
    // scrolling page in a real app design.
    const SCREEN_H = 1800;
    const NAV_H = 64;
    const CONTENT_X0 = 284;
    const CONTENT_X1 = 1416;
    const TABLE_W = 960;
    const TABLE_HEADER_H = 40;
    const TABLE_ROW_H = 56;
    const BADGE_W = 84;
    const BADGE_H = 22;
    const SCREEN_KINDS = [
      "Dashboard", "Users", "Wizards", "Settings",
      "Login / Onboarding", "Detail", "Kanban", "Calendar", "Reports",
    ];
    const OLD_KINDS = ["Dashboard", "Users", "Wizards", "Settings"];
    const LOGIN_H = 1024;
    const SCREEN_HEIGHTS = {
      "Login / Onboarding": LOGIN_H,
      Kanban: 1100,
      Calendar: 1100,
      Detail: 1200,
    };
    const DAY_OUTSIDE_FILL = "#F9FAFB";
    const LOGO_PATH = "M12 2L2 7l10 5 10-5-10-5z";
    // Calendar grid for March 2026 (weeks start on Monday): 42 cells.
    // Cells 0-5 are Feb 23-28, cells 6-36 are March 1-31, cells 37-41 are April 1-5.
    const MARCH_GRID = Array.from({ length: 42 }, (_, i) => {
      if (i < 6) return { day: 23 + i, inMonth: false };
      if (i < 37) return { day: i - 5, inMonth: true };
      return { day: i - 36, inMonth: false };
    });
    const TODAY_INDEX = 19; // March 14
    const EVENT_CHIPS = [
      { label: "Standup", tint: PALETTE.primaryTint, color: PALETTE.primary },
      { label: "Design review", tint: PALETTE.primaryTint, color: PALETTE.primary },
      { label: "Sprint demo", tint: PALETTE.successTint, color: PALETTE.success },
      { label: "1:1 Alex", tint: PALETTE.warningTint, color: PALETTE.warning },
      { label: "Release", tint: PALETTE.dangerTint, color: PALETTE.danger },
    ];
    // [initials, message, time] for activity rows.
    const ACTIVITY_LINES = [
      ["PS", "Priya Shah commented on Q3 roadmap", "5 min ago"],
      ["NI", "New invoice INV-2048 is ready", "1 hour ago"],
      ["JL", "Jordan Lee moved Acme renewal to Negotiation", "2 hours ago"],
      ["AK", "Alex Kim added 2 files to Onboarding", "Yesterday"],
      ["SO", "Sam Ortiz closed the Acme deal", "Yesterday"],
      ["MC", "Maya Chen updated the contract terms", "Mar 11"],
      ["LP", "Lee Park invited 3 members to the workspace", "Mar 9"],
      ["DR", "Dan Rossi left a note on the Acme account", "Mar 6"],
      ["AB", "Acme usage crossed 80% of the plan limit", "Mar 8"],
      ["JL", "Support ticket #4821 was resolved", "Mar 10"],
    ];
    const INFO_CARD_TITLES = ["Company", "Billing", "Contacts", "Usage", "Security", "Integrations"];
    const EVENT_LINES = [
      ["JL", "Design review with Platform team", "Today, 14:00"],
      ["PS", "Sprint planning", "Tomorrow, 10:00"],
      ["AK", "1:1 with Alex Kim", "Wed, 09:30"],
      ["SO", "Customer call: Acme", "Thu, 16:00"],
      ["MC", "Release 2.4 go/no-go", "Fri, 11:00"],
      ["LP", "Quarterly review", "Mon, 13:00"],
    ];
    const FIELD_LABELS = [
      "Full name", "Email", "Company", "Phone", "City",
      "Postal code", "Role", "Timezone", "Website", "Department",
    ];
    const SIDEBAR_ITEMS = [
      "Overview", "Users", "Projects", "Calendar", "Messages",
      "Reports", "Files", "Billing", "Support", "Settings",
    ];
    const SIDEBAR_ICONS = [
      "M3 10l9-7 9 7v10H3z",
      "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
      "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
      "M4 4h16v16H4z",
      "M4 19V5M4 19h16M8 15v-4M12 15V8M16 15v-6",
    ];

    // ---------------------------------------------------------------
    // Style factories
    // ---------------------------------------------------------------
    const solid = (color, opacity) => ({
      fillColor: color,
      fillOpacity: opacity === undefined ? 1 : opacity,
    });

    const linearGradient = (from, to) => [
      {
        fillColorGradient: {
          type: "linear",
          startX: 0,
          startY: 0,
          endX: 1,
          endY: 1,
          width: 1,
          stops: [
            { color: from, opacity: 1, offset: 0 },
            { color: to, opacity: 1, offset: 1 },
          ],
        },
      },
    ];

    const outline = (color) => [
      { strokeColor: color, strokeStyle: "solid", strokeWidth: 1, strokeAlignment: "inner", strokeOpacity: 1 },
    ];

    const bottomOutline = (color) => [
      {
        strokeColor: color,
        strokeStyle: "solid",
        strokeWidth: 0,
        strokeWidthBottom: 1,
        strokeAlignment: "inner",
        strokeOpacity: 1,
      },
    ];

    const dropShadow = (offsetY, blur, opacity) => ({
      style: "drop-shadow",
      offsetX: 0,
      offsetY,
      blur,
      spread: 0,
      color: { color: "#000000", opacity },
    });

    // ---------------------------------------------------------------
    // Shape helpers
    // ---------------------------------------------------------------
    // Runs a call that may fail on some API versions without stopping the build.
    function attempt(fn) {
      try {
        fn();
      } catch (err) {
        console.log("[large-design-warn] " + String((err && err.message) || err));
      }
    }

    function set(target, key, value) {
      if (value !== undefined) {
        attempt(() => {
          target[key] = value;
        });
      }
    }

    function applyStyle(shape, style) {
      if (!style) return shape;
      set(shape, "name", style.name);
      set(shape, "fills", style.fills);
      set(shape, "strokes", style.strokes);
      set(shape, "borderRadius", style.radius);
      set(shape, "shadows", style.shadows);
      set(shape, "opacity", style.opacity);
      if (style.clip !== undefined && shape.type === "board") {
        set(shape, "clipContent", style.clip);
      }
      if (collecting) {
        bindFills(shape, style.fills, "fill");
        bindStrokes(shape, style.strokes, "stroke");
        if (style.radius !== undefined) bindRadius(shape, style.radius);
      }
      return shape;
    }

    // Adds a shape to a parent. Passing null for lx/ly keeps the shape in flow
    // (used for children of flex layouts). Otherwise lx/ly are relative to the
    // parent origin and stored as absolute page coordinates.
    function placeIn(parent, shape, lx, ly) {
      if (parent) parent.appendChild(shape);
      if (lx === null || lx === undefined) return shape;
      const baseX = parent ? parent.x : 0;
      const baseY = parent ? parent.y : 0;
      shape.x = baseX + lx;
      shape.y = baseY + ly;
      return shape;
    }

    function makeBoard(parent, name, lx, ly, width, height, style) {
      const board = penpot.createBoard();
      attempt(() => {
        board.name = name;
      });
      board.resize(width, height);
      placeIn(parent, board, lx, ly);
      applyStyle(board, Object.assign({ fills: [solid(PALETTE.white)] }, style));
      return board;
    }

    function addRect(parent, lx, ly, width, height, style) {
      const shape = penpot.createRectangle();
      shape.resize(width, height);
      placeIn(parent, shape, lx, ly);
      return applyStyle(shape, style);
    }

    function addEllipse(parent, lx, ly, width, height, style) {
      const shape = penpot.createEllipse();
      shape.resize(width, height);
      placeIn(parent, shape, lx, ly);
      return applyStyle(shape, style);
    }

    function addText(parent, content, lx, ly, options) {
      const o = options || {};
      const size = o.size || 14;
      const text = penpot.createText(content);
      if (!text) return null;
      placeIn(parent, text, lx, ly);
      set(text, "fontSize", String(size));
      set(text, "fontWeight", String(o.weight || 400));
      set(text, "fills", [solid(o.color || PALETTE.text)]);
      if (collecting) bindFills(text, [solid(o.color || PALETTE.text)], "text");
      if (o.align) set(text, "align", o.align);
      if (o.width) {
        set(text, "growType", o.grow || "fixed");
        attempt(() => text.resize(o.width, o.height || Math.round(size * 1.5)));
      } else {
        set(text, "growType", "auto-width");
      }
      return text;
    }

    // Inline SVG icon. Icons are stroke-based unless options.fill is set.
    function addIcon(parent, pathData, lx, ly, options) {
      const o = options || {};
      const size = o.size || 16;
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">` +
        `<path d="${pathData}" fill="${o.fill || "none"}" stroke="${o.color || PALETTE.text}" ` +
        `stroke-width="${o.strokeWidth || 2}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      const group = penpot.createShapeFromSvg(svg);
      if (!group) return null;
      attempt(() => group.resize(size, size));
      if (collecting) bindSvg(group, "text", "text");
      return placeIn(parent, group, lx, ly);
    }

    function setLayout(board, settings) {
      const layout = board.addFlexLayout();
      Object.keys(settings).forEach((key) => set(layout, key, settings[key]));
      return layout;
    }

    // Replaces the text of the first text layer found in an instance, walking
    // children in the order they were added.
    function overrideFirstText(shape, value) {
      if (!shape) return false;
      if (shape.type === "text") {
        set(shape, "characters", value);
        return true;
      }
      const children = shape.children || [];
      for (const child of children) {
        if (overrideFirstText(child, value)) return true;
      }
      return false;
    }

    // Walks the text layers of an instance depth-first, in the order they were
    // added, and sets the i-th text to values[i] when that entry is a string.
    // Other entries are left alone.
    function overrideTexts(shape, values) {
      let index = 0;
      const walk = (node) => {
        if (!node) return;
        if (node.type === "text") {
          const value = values[index];
          index += 1;
          if (typeof value === "string") set(node, "characters", value);
          return;
        }
        (node.children || []).forEach(walk);
      };
      attempt(() => walk(shape));
    }

    // Downward (or any direction) triangle built from an SVG path.
    function addTriangle(parent, lx, ly, width, height, color) {
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
        `<path d="M0 0 L${width} 0 L${width / 2} ${height} Z" fill="${color}"/></svg>`;
      const shape = penpot.createShapeFromSvg(svg);
      if (!shape) return null;
      attempt(() => shape.resize(width, height));
      if (collecting) bindSvg(shape, "fill", "stroke");
      return placeIn(parent, shape, lx, ly);
    }

    function heightOf(shape, fallback) {
      return typeof shape.height === "number" ? shape.height : fallback;
    }

    // Evenly spaces `count` items of `width` so the last one ends at `end`.
    function spread(start, end, width, count) {
      if (count <= 1) return [start];
      const gap = (end - start - width * count) / (count - 1);
      return Array.from({ length: count }, (_, i) => start + i * (width + gap));
    }

    // ---------------------------------------------------------------
    // Design tokens (themed mode)
    // ---------------------------------------------------------------
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // True when pred() returns a truthy value. An exception counts as false.
    function holds(pred) {
      try {
        return !!pred();
      } catch (err) {
        return false;
      }
    }

    // Polls pred every 25 ms, up to maxTries times (default 600). Counts tries
    // instead of reading the clock. Logs and returns false on timeout.
    async function waitFor(pred, label, maxTries) {
      const limit = maxTries === undefined ? 600 : maxTries;
      for (let i = 0; i < limit; i += 1) {
        if (holds(pred)) return true;
        await sleep(25);
      }
      if (holds(pred)) return true;
      console.log("[large-design-warn] timed out waiting for " + label);
      return false;
    }

    const tokenCatalog = () => penpot.library.local.tokens;
    const THEME_TOKENS = {}; // token name -> Token from the Light set
    // page id -> Map("tokenName|attrs" -> { tokenName, attrs, shapes }).
    const pendingBindings = new Map();
    // Page ids in the order they first got a binding (Design System comes first).
    const pageOrder = [];
    const missingTokenWarned = {};
    let bindingsApplied = 0;
    // Time spent in bindAllPages: flushes counts pages bound, calls counts applyToShapes calls.
    const bindingTiming = { flushes: 0, calls: 0, applyMs: 0, waitMs: 0 };

    function findSetByName(name) {
      return Array.from(tokenCatalog().sets || []).find((s) => s.name === name) || null;
    }

    // Queues a token binding under the page that is open now. bindAllPages applies it.
    function bindToken(shape, tokenName, attrs) {
      if (!collecting || !shape || !tokenName) return;
      let pageId = null;
      try {
        pageId = penpot.currentPage.id;
      } catch (err) {
        return;
      }
      if (pageId === null || pageId === undefined) return;
      let groups = pendingBindings.get(pageId);
      if (!groups) {
        groups = new Map();
        pendingBindings.set(pageId, groups);
        pageOrder.push(pageId);
      }
      const key = tokenName + "|" + attrs.join(",");
      let group = groups.get(key);
      if (!group) {
        group = { tokenName, attrs, shapes: [] };
        groups.set(key, group);
      }
      group.shapes.push(shape);
    }

    // Token name for a colour used in a context ("text", "fill" or "stroke"), or null.
    function colorToken(context, color) {
      if (typeof color !== "string") return null;
      return COLOR_ROLE[context][color.toUpperCase()] || null;
    }

    function bindFills(shape, fills, context) {
      if (!Array.isArray(fills) || fills.length === 0) return;
      const first = fills[0];
      if (!first || typeof first.fillColor !== "string") return;
      bindToken(shape, colorToken(context, first.fillColor), ["fill"]);
    }

    function bindStrokes(shape, strokes, context) {
      if (!Array.isArray(strokes) || strokes.length === 0) return;
      const first = strokes[0];
      if (!first || typeof first.strokeColor !== "string") return;
      bindToken(shape, colorToken(context, first.strokeColor), ["strokeColor"]);
    }

    function bindRadius(shape, radius) {
      if (shape.type !== "board" && shape.type !== "rectangle") return;
      const tokenName = RADIUS_TOKEN[radius];
      if (!tokenName) return;
      bindToken(shape, tokenName, RADIUS_ATTRS);
    }

    // Binds colours in an SVG-built subtree. Groups and boards are skipped.
    function bindSvg(root, fillContext, strokeContext) {
      if (!collecting || !root) return;
      const walk = (node) => {
        if (!node) return;
        attempt(() => {
          if (node.type === "group" || node.type === "board") return;
          bindFills(node, node.fills, fillContext);
          bindStrokes(node, node.strokes, strokeContext);
        });
        attempt(() => (node.children || []).forEach((child) => walk(child)));
      };
      walk(root);
    }

    // Full and init modes. Creates the Light, Dark and Mid token sets and themes
    // when missing, fills the sets, activates Light and binds the Light tokens.
    async function setupThemeTokens() {
      const catalog = tokenCatalog();
      const sets = [];
      for (let i = 0; i < THEME_NAMES.length; i += 1) {
        const name = THEME_NAMES[i];
        if (!findSetByName(name)) {
          catalog.addSet({ name });
          await waitFor(() => findSetByName(name) !== null, "token set " + name);
        }
        const tokenSet = findSetByName(name);
        if (!tokenSet) throw new Error("could not create token set " + name);
        const existing = new Set(Array.from(tokenSet.tokens || []).map((t) => t.name));
        Object.keys(THEME_COLORS).forEach((tokenName) => {
          if (existing.has(tokenName)) return;
          attempt(() => {
            tokenSet.addToken({ type: "color", name: tokenName, value: THEME_COLORS[tokenName][i] });
          });
        });
        Object.keys(THEME_RADII).forEach((tokenName) => {
          if (existing.has(tokenName)) return;
          attempt(() => {
            tokenSet.addToken({ type: "borderRadius", name: tokenName, value: THEME_RADII[tokenName] });
          });
        });
        const expectedTokens = Object.keys(THEME_COLORS).length + Object.keys(THEME_RADII).length;
        await waitFor(() => tokenSet.tokens.length >= expectedTokens, "tokens in set " + name);
        sets.push(tokenSet);
      }

      const findTheme = (name) =>
        Array.from(catalog.themes || []).find((t) => t.name === name && t.group === THEME_GROUP) || null;
      for (let i = 0; i < THEME_NAMES.length; i += 1) {
        const name = THEME_NAMES[i];
        if (!findTheme(name)) {
          catalog.addTheme({ group: THEME_GROUP, name });
          await waitFor(() => findTheme(name) !== null, "theme " + name);
        }
        const theme = findTheme(name);
        if (!theme) throw new Error("could not create theme " + name);
        const hasSet = () => Array.from(theme.activeSets || []).some((s) => s.name === name);
        if (!hasSet()) {
          theme.addSet(sets[i]);
          await waitFor(hasSet, "set " + name + " in theme " + name);
        }
      }

      const light = findTheme(THEME_NAMES[0]);
      if (light && !light.active) {
        light.active = true;
        await waitFor(() => light.active === true, "Light theme active");
      }

      const lightSet = findSetByName(THEME_NAMES[0]);
      Array.from((lightSet && lightSet.tokens) || []).forEach((t) => {
        THEME_TOKENS[t.name] = t;
      });
      themingOn = true;
      console.log("[large-design] themes ready " + THEME_NAMES.join(", "));
    }

    // Append mode. Binds new screens to the Light tokens made by an earlier run.
    async function loadThemeTokens() {
      const lightSet = findSetByName(THEME_NAMES[0]);
      if (!lightSet) {
        console.log("[large-design-warn] no Light token set; screens are not themed");
        return;
      }
      Array.from(lightSet.tokens || []).forEach((t) => {
        THEME_TOKENS[t.name] = t;
      });
      themingOn = true;
    }

    // Binds the queued tokens, one page at a time, at the end of the run (after
    // the screens exist). Copies are not touched: they get their bindings from
    // their mains through component sync.
    async function bindAllPages() {
      if (!THEMED) return;
      if (!themingOn) {
        // Append mode: loadThemeTokens has already warned when there is no Light set.
        if (mode === "append") return;
        await setupThemeTokens();
      }
      for (const pageId of pageOrder) {
        const groups = pendingBindings.get(pageId);
        pendingBindings.delete(pageId);
        if (!groups || groups.size === 0) continue;
        const page = Array.from(penpot.currentFile.pages || []).find((p) => p.id === pageId);
        if (!page) {
          console.log("[large-design-warn] page " + pageId + " not found; its bindings are skipped");
          continue;
        }
        const pageStart = Date.now();
        await openPageIfNeeded(page);
        const applied = [];
        let shapesCount = 0;
        let groupCount = 0;
        for (const group of groups.values()) {
          const token = THEME_TOKENS[group.tokenName];
          if (!token) {
            if (!missingTokenWarned[group.tokenName]) {
              missingTokenWarned[group.tokenName] = true;
              console.log("[large-design-warn] no token " + group.tokenName);
            }
            continue;
          }
          const key = group.attrs[0];
          const seen = new Set();
          const shapes = [];
          group.shapes.forEach((shape) => {
            try {
              if (seen.has(shape.id)) return;
              seen.add(shape.id);
              // Applying a token that is already applied would toggle it off.
              if ((shape.tokens || {})[key] === group.tokenName) return;
              shapes.push(shape);
            } catch (err) {
              // Unreadable shape: leave it out.
            }
          });
          if (shapes.length === 0) continue;
          const applyStart = Date.now();
          attempt(() => token.applyToShapes(shapes, group.attrs));
          bindingTiming.applyMs += Date.now() - applyStart;
          bindingTiming.calls += 1;
          bindingsApplied += shapes.length;
          shapesCount += shapes.length;
          groupCount += 1;
          applied.push({ tokenName: group.tokenName, key, shapes });
        }
        bindingTiming.flushes += 1;
        const waitStart = Date.now();
        await waitFor(
          () =>
            applied.every((item) => {
              try {
                return item.shapes.every((shape) => (shape.tokens || {})[item.key] === item.tokenName);
              } catch (err) {
                // A shape that cannot be read (for example deleted) counts as done.
                return true;
              }
            }),
          "token bindings on page " + page.name,
          4800
        );
        bindingTiming.waitMs += Date.now() - waitStart;
        console.log(
          "[large-design] bound page " + page.name + ": " + shapesCount + " shapes in " + groupCount +
            " calls, " + (Date.now() - pageStart) + " ms"
        );
        // Lets the page save before the next one.
        await sleep(3000);
      }
      console.log("[large-design] binding done " + JSON.stringify(bindingTiming));
    }

    // ---------------------------------------------------------------
    // Component registry and layout slots for the Design System page
    // ---------------------------------------------------------------
    const DS = {};
    let componentCount = 0;
    const flow = { x: 0, y: 0, rowHeight: 0 };
    const FLOW_WIDTH = 1600;
    const FLOW_GAP = 80;

    function nextSlot(width, height) {
      if (flow.x > 0 && flow.x + width > FLOW_WIDTH) {
        flow.x = 0;
        flow.y += flow.rowHeight + FLOW_GAP;
        flow.rowHeight = 0;
      }
      const slot = { x: flow.x, y: flow.y };
      flow.x += width + FLOW_GAP;
      flow.rowHeight = Math.max(flow.rowHeight, height);
      return slot;
    }

    async function registerComponent(key, board) {
      DS[key] = penpot.library.local.createComponent([board]);
      componentCount += 1;
      return DS[key];
    }

    const instance = (key) => DS[key].instance();

    // ---------------------------------------------------------------
    // a. Design System components
    // ---------------------------------------------------------------
    async function buildAvatar() {
      const slot = nextSlot(40, 40);
      const board = makeBoard(null, "Avatar", slot.x, slot.y, 40, 40, { fills: [] });
      addEllipse(board, 0, 0, 40, 40, { fills: linearGradient("#6366F1", "#A78BFA") });
      addText(board, "AB", 0, 11, {
        size: 14,
        weight: 700,
        color: PALETTE.white,
        align: "center",
        width: 40,
        height: 18,
      });
      await registerComponent("avatar", board);
    }

    async function buildBadge(key, name, tint, textColor, label) {
      const slot = nextSlot(BADGE_W, BADGE_H);
      const board = makeBoard(null, name, slot.x, slot.y, BADGE_W, BADGE_H, { fills: [] });
      addRect(board, 0, 0, BADGE_W, BADGE_H, { fills: [solid(tint)], radius: 999 });
      addText(board, label, 0, 3, {
        size: 12,
        weight: 600,
        color: textColor,
        align: "center",
        width: BADGE_W,
        height: 16,
      });
      await registerComponent(key, board);
    }

    async function buildBadges() {
      await buildBadge("badgePrimary", "Badge / Primary", PALETTE.primaryTint, PALETTE.primary, "Active");
      await buildBadge("badgeSuccess", "Badge / Success", PALETTE.successTint, PALETTE.success, "Paid");
      await buildBadge("badgeWarning", "Badge / Warning", PALETTE.warningTint, PALETTE.warning, "Pending");
      await buildBadge("badgeDanger", "Badge / Danger", PALETTE.dangerTint, PALETTE.danger, "Failed");
    }

    async function buildButton(key, name, variant) {
      const slot = nextSlot(120, 40);
      const board = makeBoard(null, name, slot.x, slot.y, 120, 40, {
        fills: variant.fills,
        strokes: variant.strokes || [],
        radius: 8,
      });
      setLayout(board, {
        dir: "row",
        horizontalPadding: 16,
        verticalPadding: 10,
        columnGap: 8,
        alignItems: "center",
        // Hug the label so longer overrides ("Save changes") are not clipped.
        horizontalSizing: "auto",
      });
      if (variant.icon) {
        addIcon(board, variant.icon, null, null, { size: 16, color: variant.color, strokeWidth: 2 });
      }
      addText(board, variant.label, null, null, { size: 14, weight: 700, color: variant.color });
      await registerComponent(key, board);
    }

    async function buildButtons() {
      await buildButton("buttonPrimary", "Button / Primary", {
        fills: [solid(PALETTE.primary)],
        color: PALETTE.white,
        label: "Primary",
        icon: "M12 5v14M5 12h14",
      });
      await buildButton("buttonSecondary", "Button / Secondary", {
        fills: [solid(PALETTE.white)],
        strokes: outline(PALETTE.inputBorder),
        color: PALETTE.text,
        label: "Secondary",
      });
      await buildButton("buttonGhost", "Button / Ghost", {
        fills: [],
        color: PALETTE.primary,
        label: "Ghost",
      });
    }

    async function buildInput() {
      const slot = nextSlot(280, 66);
      const board = makeBoard(null, "Input", slot.x, slot.y, 280, 66, { fills: [] });
      setLayout(board, { dir: "column", rowGap: 6, alignItems: "start" });
      addText(board, "Email", null, null, { size: 12, color: PALETTE.muted });
      const field = makeBoard(board, "Input / Field", null, null, 280, 40, {
        fills: [solid(PALETTE.white)],
        strokes: outline(PALETTE.inputBorder),
        radius: 6,
      });
      setLayout(field, {
        dir: "row",
        horizontalPadding: 12,
        alignItems: "center",
        justifyContent: "space-between",
      });
      addText(field, "Search...", null, null, { size: 14, color: PALETTE.muted });
      addIcon(field, "M6 9l6 6 6-6", null, null, { size: 16, color: PALETTE.muted });
      await registerComponent("input", board);
    }

    async function buildCheckbox() {
      const slot = nextSlot(160, 16);
      const board = makeBoard(null, "Checkbox", slot.x, slot.y, 160, 16, { fills: [] });
      setLayout(board, { dir: "row", columnGap: 8, alignItems: "center" });
      // Wrapper holds the box and the check icon as siblings.
      const box = makeBoard(board, "Checkbox / Box", null, null, 16, 16, { fills: [] });
      addRect(box, 0, 0, 16, 16, {
        fills: [solid(PALETTE.white)],
        strokes: outline(PALETTE.inputBorder),
        radius: 4,
      });
      addIcon(box, "M20 6L9 17l-5-5", 0, 0, { size: 16, color: PALETTE.primary, strokeWidth: 2.5 });
      addText(board, "Remember me", null, null, { size: 14, color: PALETTE.text });
      await registerComponent("checkbox", board);
    }

    async function buildToggle() {
      const slot = nextSlot(140, 20);
      const board = makeBoard(null, "Toggle", slot.x, slot.y, 140, 20, { fills: [] });
      setLayout(board, { dir: "row", columnGap: 8, alignItems: "center" });
      const track = makeBoard(board, "Toggle / Track", null, null, 36, 20, { fills: [] });
      addRect(track, 0, 0, 36, 20, { fills: [solid(PALETTE.toggleOff)], radius: 10 });
      addEllipse(track, 2, 2, 16, 16, { fills: [solid(PALETTE.white)] });
      addText(board, "Enabled", null, null, { size: 14, color: PALETTE.text });
      await registerComponent("toggle", board);
    }

    async function buildTableHeaderCell() {
      const slot = nextSlot(160, 40);
      const board = makeBoard(null, "Table / Header Cell", slot.x, slot.y, 160, 40, {
        fills: [],
        strokes: bottomOutline(PALETTE.border),
      });
      addText(board, "NAME", 16, 12, { size: 12, weight: 700, color: PALETTE.muted });
      await registerComponent("tableHeaderCell", board);
    }

    async function buildTableRow() {
      const slot = nextSlot(TABLE_W, TABLE_ROW_H);
      const row = makeBoard(null, "Table / Row", slot.x, slot.y, TABLE_W, TABLE_ROW_H, {
        fills: [solid(PALETTE.white)],
        strokes: bottomOutline(PALETTE.border),
      });
      setLayout(row, {
        dir: "row",
        horizontalPadding: 16,
        alignItems: "center",
        columnGap: 16,
      });
      row.appendChild(instance("avatar"));
      addText(row, "Jordan Lee", null, null, {
        size: 14,
        weight: 600,
        color: PALETTE.text,
        width: 200,
        height: 20,
      });
      addText(row, "jordan@example.com", null, null, {
        size: 13,
        color: PALETTE.muted,
        width: 220,
        height: 20,
      });
      row.appendChild(instance(pick(["badgePrimary", "badgeSuccess", "badgeWarning", "badgeDanger"])));
      addText(row, "Mar 14, 2026", null, null, {
        size: 13,
        color: PALETTE.muted,
        width: 110,
        height: 20,
      });
      addText(row, "$1,240.00", null, null, {
        size: 14,
        color: PALETTE.text,
        align: "right",
        width: 100,
        height: 20,
      });
      addIcon(row, "M12 5h.01M12 12h.01M12 19h.01", null, null, {
        size: 16,
        color: PALETTE.muted,
        strokeWidth: 3,
      });
      await registerComponent("tableRow", row);
    }

    async function buildTable() {
      const height = TABLE_HEADER_H + config.tableRows * TABLE_ROW_H;
      const slot = nextSlot(TABLE_W, height);
      const table = makeBoard(null, "Table", slot.x, slot.y, TABLE_W, height, {
        fills: [solid(PALETTE.white)],
        strokes: outline(PALETTE.border),
        radius: 12,
      });
      setLayout(table, { dir: "column", alignItems: "stretch" });

      const header = makeBoard(table, "Table / Header", null, null, TABLE_W, TABLE_HEADER_H, { fills: [] });
      setLayout(header, { dir: "row", alignItems: "center" });
      ["NAME", "EMAIL", "ROLE", "JOINED", "AMOUNT", "ACTIONS"].forEach((label) => {
        const cell = instance("tableHeaderCell");
        header.appendChild(cell);
        overrideFirstText(cell, label);
      });

      for (let i = 0; i < config.tableRows; i += 1) {
        table.appendChild(instance("tableRow"));
      }
      await registerComponent("table", table);
    }

    async function buildCard() {
      const slot = nextSlot(328, 340);
      const card = makeBoard(null, "Card", slot.x, slot.y, 328, 340, {
        fills: [solid(PALETTE.white)],
        radius: 12,
        shadows: [dropShadow(8, 24, 0.12)],
      });
      setLayout(card, {
        dir: "column",
        horizontalPadding: 16,
        verticalPadding: 16,
        rowGap: 12,
        alignItems: "start",
      });
      addRect(card, null, null, 296, 120, {
        fills: linearGradient("#6366F1", "#38BDF8"),
        radius: 8,
      });
      addText(card, "Monthly revenue", null, null, {
        size: 18,
        weight: 700,
        color: PALETTE.text,
        width: 296,
        height: 26,
      });
      addText(card, "Track recurring revenue, churn and expansion across every plan tier in one view.", null, null, {
        size: 14,
        color: PALETTE.muted,
        width: 296,
        height: 40,
        grow: "auto-height",
      });
      card.appendChild(instance("badgePrimary"));
      const cta = instance("buttonPrimary");
      card.appendChild(cta);
      overrideFirstText(cta, "Details");
      await registerComponent("card", card);
    }

    async function buildChartCard() {
      const slot = nextSlot(360, 280);
      const card = makeBoard(null, "Chart Card", slot.x, slot.y, 360, 280, {
        fills: [solid(PALETTE.white)],
        radius: 12,
        shadows: [dropShadow(8, 24, 0.12)],
      });
      addText(card, "Weekly signups", 16, 16, { size: 16, weight: 700, color: PALETTE.text });
      for (let i = 0; i < 12; i += 1) {
        const barHeight = int(40, 180);
        addRect(card, 32 + i * 24, 220 - barHeight, 16, barHeight, {
          fills: linearGradient("#6366F1", "#A78BFA"),
          radius: 4,
        });
      }
      addRect(card, 16, 220, 328, 1, { fills: [solid(PALETTE.border)] });
      addRect(card, 16, 134, 328, 1, { fills: [solid(PALETTE.border)] });
      ["Jan", "Feb", "Mar", "Apr", "May", "Jun"].forEach((month, i) => {
        addText(card, month, 32 + i * 56, 236, { size: 11, color: PALETTE.muted });
      });
      await registerComponent("chartCard", card);
    }

    async function buildModal() {
      const slot = nextSlot(560, 330);
      const modal = makeBoard(null, "Modal", slot.x, slot.y, 560, 330, {
        fills: [solid(PALETTE.white)],
        radius: 16,
        shadows: [dropShadow(24, 48, 0.16), dropShadow(4, 12, 0.08)],
      });
      setLayout(modal, {
        dir: "column",
        horizontalPadding: 32,
        verticalPadding: 32,
        rowGap: 16,
        alignItems: "start",
      });

      const header = makeBoard(modal, "Modal / Header", null, null, 496, 28, { fills: [] });
      setLayout(header, { dir: "row", justifyContent: "space-between", alignItems: "center" });
      addText(header, "Delete project?", null, null, { size: 20, weight: 700, color: PALETTE.text });
      addIcon(header, "M18 6L6 18M6 6l12 12", null, null, { size: 20, color: PALETTE.muted });

      [
        "This removes the project, its files and every comment attached to it.",
        "Members lose access straight away. The action cannot be undone from this screen.",
        "Export a copy first if you need the data later.",
      ].forEach((paragraph) => {
        addText(modal, paragraph, null, null, {
          size: 14,
          color: PALETTE.muted,
          width: 496,
          height: 20,
          grow: "auto-height",
        });
      });

      const footer = makeBoard(modal, "Modal / Footer", null, null, 496, 40, { fills: [] });
      setLayout(footer, { dir: "row", justifyContent: "end", columnGap: 12, alignItems: "center" });
      footer.appendChild(instance("buttonSecondary"));
      footer.appendChild(instance("buttonPrimary"));
      await registerComponent("modal", modal);
    }

    async function buildWizard() {
      const slot = nextSlot(TABLE_W, 560);
      const wizard = makeBoard(null, "Wizard", slot.x, slot.y, TABLE_W, 560, {
        fills: [solid(PALETTE.white)],
        strokes: outline(PALETTE.border),
        radius: 12,
      });
      setLayout(wizard, {
        dir: "column",
        horizontalPadding: 32,
        verticalPadding: 32,
        rowGap: 24,
        alignItems: "start",
      });

      // Stepper: 5 steps, 217 px apart, connectors on the circle line.
      const stepper = makeBoard(wizard, "Wizard / Stepper", null, null, 896, 56, { fills: [], clip: false });
      const states = ["done", "done", "active", "todo", "todo"];
      const labels = ["Account", "Profile", "Team", "Billing", "Review"];
      const stepFill = {
        done: PALETTE.success,
        active: PALETTE.primary,
        todo: PALETTE.border,
      };
      states.forEach((state, i) => {
        const cx = i * 217;
        addEllipse(stepper, cx, 0, 28, 28, { fills: [solid(stepFill[state])] });
        if (state === "done") {
          addIcon(stepper, "M20 6L9 17l-5-5", cx + 6, 6, { size: 16, color: PALETTE.white, strokeWidth: 2.5 });
        } else {
          addText(stepper, String(i + 1), cx, 6, {
            size: 12,
            weight: 700,
            color: state === "active" ? PALETTE.white : PALETTE.muted,
            align: "center",
            width: 28,
            height: 16,
          });
        }
        addText(stepper, labels[i], cx, 36, {
          size: 13,
          weight: state === "active" ? 600 : 400,
          color: state === "todo" ? PALETTE.muted : PALETTE.text,
        });
        if (i < states.length - 1) {
          addRect(stepper, cx + 32, 13, 181, 1, {
            fills: [solid(state === "done" ? PALETTE.success : PALETTE.border)],
          });
        }
      });

      const form = makeBoard(wizard, "Wizard / Form", null, null, 896, 300, { fills: [] });
      setLayout(form, { dir: "column", rowGap: 16, alignItems: "start" });
      for (let i = 0; i < 4; i += 1) form.appendChild(instance("input"));
      form.appendChild(instance("checkbox"));

      const footer = makeBoard(wizard, "Wizard / Footer", null, null, 896, 40, { fills: [] });
      setLayout(footer, { dir: "row", justifyContent: "space-between", alignItems: "center" });
      const back = instance("buttonSecondary");
      footer.appendChild(back);
      overrideFirstText(back, "Back");
      const next = instance("buttonPrimary");
      footer.appendChild(next);
      overrideFirstText(next, "Next");
      await registerComponent("wizard", wizard);
    }

    async function buildNavBar() {
      const slot = nextSlot(1440, NAV_H);
      const nav = makeBoard(null, "NavBar", slot.x, slot.y, 1440, NAV_H, {
        fills: [solid(PALETTE.white)],
        strokes: bottomOutline(PALETTE.border),
      });
      setLayout(nav, {
        dir: "row",
        horizontalPadding: 24,
        alignItems: "center",
        justifyContent: "space-between",
      });

      const left = makeBoard(nav, "NavBar / Left", null, null, 800, 40, { fills: [] });
      setLayout(left, { dir: "row", columnGap: 24, alignItems: "center" });
      addIcon(left, "M12 2L2 7l10 5 10-5-10-5z", null, null, {
        size: 24,
        fill: PALETTE.primary,
        color: "none",
      });
      addText(left, "Acme", null, null, { size: 16, weight: 700, color: PALETTE.text });
      ["Dashboard", "Users", "Projects", "Reports", "Settings"].forEach((item) => {
        addText(left, item, null, null, { size: 14, color: PALETTE.muted });
      });

      const right = makeBoard(nav, "NavBar / Right", null, null, 320, 40, { fills: [] });
      setLayout(right, { dir: "row", columnGap: 16, alignItems: "center" });
      const search = instance("input");
      right.appendChild(search);
      overrideFirstText(search, "Search");
      right.appendChild(instance("avatar"));
      await registerComponent("navBar", nav);
    }

    function buildMenuItem(parent, label, iconPath, active) {
      const item = makeBoard(parent, "Sidebar / " + label, null, null, 228, 36, {
        fills: active ? [solid(PALETTE.sidebarActive)] : [],
        radius: 8,
      });
      setLayout(item, {
        dir: "row",
        horizontalPadding: 12,
        verticalPadding: 8,
        columnGap: 12,
        alignItems: "center",
      });
      const color = active ? PALETTE.white : PALETTE.sidebarText;
      addIcon(item, iconPath, null, null, { size: 16, color });
      addText(item, label, null, null, { size: 14, color });
    }

    async function buildSidebar() {
      const slot = nextSlot(260, SCREEN_H - NAV_H);
      const sidebar = makeBoard(null, "Sidebar", slot.x, slot.y, 260, SCREEN_H - NAV_H, {
        fills: [solid(PALETTE.sidebar)],
      });
      setLayout(sidebar, {
        dir: "column",
        horizontalPadding: 16,
        verticalPadding: 24,
        rowGap: 4,
        alignItems: "stretch",
      });
      addText(sidebar, "MAIN", null, null, { size: 11, weight: 600, color: PALETTE.muted });
      SIDEBAR_ITEMS.slice(0, 5).forEach((label, i) => {
        buildMenuItem(sidebar, label, SIDEBAR_ICONS[i % SIDEBAR_ICONS.length], i === 0);
      });
      addText(sidebar, "ACCOUNT", null, null, { size: 11, weight: 600, color: PALETTE.muted });
      SIDEBAR_ITEMS.slice(5).forEach((label, i) => {
        buildMenuItem(sidebar, label, SIDEBAR_ICONS[(i + 5) % SIDEBAR_ICONS.length], false);
      });
      await registerComponent("sidebar", sidebar);
    }

    async function buildToast() {
      const slot = nextSlot(380, 48);
      const toast = makeBoard(null, "Toast", slot.x, slot.y, 380, 48, {
        fills: [solid(PALETTE.white)],
        radius: 12,
        shadows: [dropShadow(8, 24, 0.12)],
      });
      setLayout(toast, {
        dir: "row",
        horizontalPadding: 16,
        verticalPadding: 12,
        columnGap: 12,
        alignItems: "center",
      });
      addIcon(toast, "M20 6L9 17l-5-5", null, null, {
        size: 16,
        color: PALETTE.success,
        strokeWidth: 2.5,
      });
      addText(toast, "Changes saved successfully.", null, null, {
        size: 14,
        color: PALETTE.text,
        width: 300,
        height: 20,
        grow: "auto-height",
      });
      addIcon(toast, "M18 6L6 18M6 6l12 12", null, null, { size: 16, color: PALETTE.muted });
      await registerComponent("toast", toast);
    }

    async function buildStatTile() {
      const slot = nextSlot(280, 130);
      const tile = makeBoard(null, "Stat Tile", slot.x, slot.y, 280, 130, {
        fills: [solid(PALETTE.white)],
        strokes: outline(PALETTE.border),
        radius: 12,
      });
      setLayout(tile, {
        dir: "column",
        horizontalPadding: 20,
        verticalPadding: 20,
        rowGap: 8,
        alignItems: "start",
      });
      addText(tile, "Total revenue", null, null, { size: 13, color: PALETTE.muted });
      addText(tile, "$48,250", null, null, { size: 32, weight: 700, color: PALETTE.text });
      const delta = instance("badgeSuccess");
      tile.appendChild(delta);
      overrideFirstText(delta, "+12.4%");
      await registerComponent("statTile", tile);
    }

    async function buildTabs() {
      const slot = nextSlot(1132, 44);
      const tabs = makeBoard(null, "Tabs", slot.x, slot.y, 1132, 44, {
        fills: [],
        strokes: bottomOutline(PALETTE.border),
      });
      setLayout(tabs, { dir: "row", columnGap: 0, alignItems: "start" });
      const underline = [
        {
          strokeColor: PALETTE.primary,
          strokeStyle: "solid",
          strokeWidth: 0,
          strokeWidthBottom: 2,
          strokeAlignment: "inner",
          strokeOpacity: 1,
        },
      ];
      ["Overview", "Activity", "Files", "Members", "Settings"].forEach((label, i) => {
        const active = i === 0;
        const tab = makeBoard(tabs, "Tabs / " + label, null, null, 132, 44, {
          fills: [],
          strokes: active ? underline : [],
        });
        setLayout(tab, { dir: "row", justifyContent: "center", alignItems: "center" });
        addText(tab, label, null, null, {
          size: 14,
          weight: active ? 600 : 500,
          color: active ? PALETTE.primary : PALETTE.muted,
        });
      });
      await registerComponent("tabs", tabs);
    }

    async function buildDropdownMenu() {
      const slot = nextSlot(240, 320);
      const menu = makeBoard(null, "Dropdown Menu", slot.x, slot.y, 240, 320, {
        fills: [solid(PALETTE.white)],
        strokes: outline(PALETTE.border),
        radius: 8,
        shadows: [dropShadow(12, 32, 0.16), dropShadow(2, 6, 0.06)],
      });
      setLayout(menu, {
        dir: "column",
        horizontalPadding: 6,
        verticalPadding: 6,
        rowGap: 2,
        alignItems: "start",
        verticalSizing: "auto",
      });
      const items = [
        ["Edit", "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z", PALETTE.text],
        ["Duplicate", "M9 9h11v11H9zM5 15V5h10", PALETTE.text],
        ["Share", "M4 12v7h16v-7M12 3v12M8 7l4-4 4 4", PALETTE.text],
        ["Move to folder", "M3 7h6l2 2h10v10H3z", PALETTE.text],
        ["Rename", "M4 20l4-1L19 8l-3-3L5 16z", PALETTE.text],
        ["Export", "M12 3v12M8 11l4 4 4-4M4 17v3h16v-3", PALETTE.text],
        ["Archive", "M3 4h18v4H3zM5 8v12h14V8M10 12h4", PALETTE.text],
        ["Delete", "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14", PALETTE.danger],
      ];
      items.forEach(([label, iconPath, color], i) => {
        const item = makeBoard(menu, "Dropdown Menu / " + label, null, null, 228, 36, {
          fills: i === 0 ? [solid("#F3F4F6")] : [],
          radius: 6,
        });
        setLayout(item, {
          dir: "row",
          horizontalPadding: 12,
          verticalPadding: 8,
          columnGap: 10,
          alignItems: "center",
        });
        addIcon(item, iconPath, null, null, { size: 16, color: color === PALETTE.danger ? color : PALETTE.muted });
        addText(item, label, null, null, { size: 14, color });
        if (i === 6) addRect(menu, null, null, 228, 1, { fills: [solid(PALETTE.border)] });
      });
      await registerComponent("dropdownMenu", menu);
    }

    async function buildTooltip() {
      const slot = nextSlot(168, 38);
      const tooltip = makeBoard(null, "Tooltip", slot.x, slot.y, 168, 38, { fills: [] });
      const pill = makeBoard(tooltip, "Tooltip / Pill", 0, 0, 168, 32, {
        fills: [solid(PALETTE.text)],
        radius: 6,
      });
      setLayout(pill, { dir: "row", justifyContent: "center", alignItems: "center" });
      addText(pill, "Copy link to clipboard", null, null, {
        size: 12,
        weight: 500,
        color: PALETTE.white,
      });
      addTriangle(tooltip, (168 - 12) / 2, 32, 12, 6, PALETTE.text);
      await registerComponent("tooltip", tooltip);
    }

    async function buildKanbanCard() {
      const slot = nextSlot(192, 132);
      const card = makeBoard(null, "Kanban / Card", slot.x, slot.y, 192, 132, {
        fills: [solid(PALETTE.white)],
        strokes: outline(PALETTE.border),
        radius: 8,
        shadows: [dropShadow(1, 3, 0.08)],
      });
      setLayout(card, {
        dir: "column",
        horizontalPadding: 12,
        verticalPadding: 12,
        rowGap: 8,
        alignItems: "start",
        verticalSizing: "auto",
      });
      // Tag pill; screens override its label per card (see composeKanban).
      const tag = instance("badgePrimary");
      card.appendChild(tag);
      overrideFirstText(tag, "Backend");
      // Fixed two-line height: auto-height text is measured too late for the
      // flex layout, so the second line would run into the footer.
      addText(card, "Migrate billing service to new API", null, null, {
        size: 13,
        weight: 600,
        color: PALETTE.text,
        width: 168,
        height: 36,
        grow: "fixed",
      });
      const footer = makeBoard(card, "Kanban / Card Footer", null, null, 168, 24, { fills: [] });
      setLayout(footer, { dir: "row", justifyContent: "space-between", alignItems: "center" });
      addEllipse(footer, null, null, 24, 24, { fills: linearGradient("#6366F1", "#A78BFA") });
      addText(footer, "Apr 12 · 3 comments", null, null, { size: 12, color: PALETTE.muted });
      await registerComponent("kanbanCard", card);
    }

    async function buildKanbanColumn() {
      const slot = nextSlot(216, 900);
      const column = makeBoard(null, "Kanban / Column", slot.x, slot.y, 216, 900, {
        fills: [solid("#F3F4F6")],
        radius: 12,
      });
      setLayout(column, {
        dir: "column",
        horizontalPadding: 12,
        verticalPadding: 12,
        rowGap: 8,
        alignItems: "start",
        verticalSizing: "auto",
      });
      const header = makeBoard(column, "Kanban / Column Header", null, null, 192, 28, { fills: [] });
      setLayout(header, { dir: "row", justifyContent: "space-between", alignItems: "center" });
      addText(header, "In progress", null, null, { size: 14, weight: 700, color: PALETTE.text });
      const count = instance("badgePrimary");
      header.appendChild(count);
      overrideFirstText(count, "6");
      for (let i = 0; i < 6; i += 1) column.appendChild(instance("kanbanCard"));
      await registerComponent("kanbanColumn", column);
    }

    async function buildCalendar() {
      const slot = nextSlot(728, 688);
      const calendar = makeBoard(null, "Calendar", slot.x, slot.y, 728, 688, {
        fills: [solid(PALETTE.white)],
        strokes: outline(PALETTE.border),
        radius: 12,
        clip: true,
      });

      // Header: title on the left, two buttons on the right.
      const header = makeBoard(calendar, "Calendar / Header", 0, 0, 728, 56, {
        fills: [],
        strokes: bottomOutline(PALETTE.border),
      });
      setLayout(header, {
        dir: "row",
        horizontalPadding: 16,
        alignItems: "center",
        justifyContent: "space-between",
      });
      addText(header, "March 2026", null, null, { size: 18, weight: 700, color: PALETTE.text });
      const actions = makeBoard(header, "Calendar / Header Actions", null, null, 252, 40, { fills: [] });
      setLayout(actions, { dir: "row", columnGap: 12, alignItems: "center" });
      const today = instance("buttonSecondary");
      actions.appendChild(today);
      overrideFirstText(today, "Today");
      const month = instance("buttonSecondary");
      actions.appendChild(month);
      overrideFirstText(month, "Month");

      // Weekday labels, 104 px columns.
      const weekRow = makeBoard(calendar, "Calendar / Weekdays", 0, 56, 728, 32, { fills: [] });
      ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((label, i) => {
        addText(weekRow, label, i * 104, 8, {
          size: 12,
          weight: 600,
          color: PALETTE.muted,
          align: "center",
          width: 104,
          height: 16,
        });
      });

      // Pick the cells that get event chips.
      const candidates = [];
      MARCH_GRID.forEach((cell, i) => {
        if (cell.inMonth) candidates.push(i);
      });
      const eventCells = new Set();
      const eventTotal = int(6, 8);
      while (eventCells.size < eventTotal) {
        eventCells.add(candidates[Math.floor(rand() * candidates.length)]);
      }

      // 7 x 6 day grid, placed absolutely.
      MARCH_GRID.forEach((cell, i) => {
        const col = i % 7;
        const row = Math.floor(i / 7);
        const isToday = i === TODAY_INDEX;
        const day = makeBoard(calendar, "Calendar / Day " + cell.day, col * 104, 88 + row * 100, 104, 100, {
          fills: [solid(cell.inMonth ? PALETTE.white : DAY_OUTSIDE_FILL)],
          strokes: outline(PALETTE.border),
        });
        if (isToday) {
          addEllipse(day, 5, 4, 22, 22, { fills: [solid(PALETTE.primary)] });
          addText(day, String(cell.day), 5, 6, {
            size: 12,
            weight: 700,
            color: PALETTE.white,
            align: "center",
            width: 22,
            height: 18,
          });
        } else {
          addText(day, String(cell.day), 8, 6, {
            size: 12,
            color: cell.inMonth ? PALETTE.text : PALETTE.muted,
          });
        }
        if (eventCells.has(i)) {
          const chipCount = int(1, 2);
          for (let k = 0; k < chipCount; k += 1) {
            const event = pick(EVENT_CHIPS);
            const chip = makeBoard(day, "Calendar / Event", 8, 28 + k * 24, 88, 20, {
              fills: [solid(event.tint)],
              radius: 4,
            });
            addText(chip, event.label, 6, 3, { size: 11, weight: 600, color: event.color });
          }
        }
      });
      await registerComponent("calendar", calendar);
    }

    async function buildBreadcrumbs() {
      const slot = nextSlot(360, 20);
      const crumbs = makeBoard(null, "Breadcrumbs", slot.x, slot.y, 360, 20, { fills: [] });
      setLayout(crumbs, {
        dir: "row",
        columnGap: 8,
        alignItems: "center",
        horizontalSizing: "auto",
        verticalSizing: "auto",
      });
      const trail = ["Home", "Customers", "Acme Corporation"];
      trail.forEach((label, i) => {
        const last = i === trail.length - 1;
        addText(crumbs, label, null, null, {
          size: 13,
          weight: last ? 600 : 400,
          color: last ? PALETTE.text : PALETTE.muted,
        });
        if (!last) addIcon(crumbs, "M9 6l6 6-6 6", null, null, { size: 14, color: PALETTE.muted });
      });
      await registerComponent("breadcrumbs", crumbs);
    }

    async function buildPagination() {
      const slot = nextSlot(960, 40);
      const pagination = makeBoard(null, "Pagination", slot.x, slot.y, 960, 40, { fills: [] });
      setLayout(pagination, { dir: "row", justifyContent: "space-between", alignItems: "center" });
      addText(pagination, "Showing 1–12 of 248 results", null, null, { size: 13, color: PALETTE.muted });

      const controls = makeBoard(pagination, "Pagination / Controls", null, null, 456, 40, { fills: [] });
      setLayout(controls, { dir: "row", columnGap: 6, alignItems: "center" });
      const previous = instance("buttonSecondary");
      controls.appendChild(previous);
      overrideFirstText(previous, "Previous");
      ["1", "2", "3", "…", "21"].forEach((label) => {
        const active = label === "1";
        const box = makeBoard(controls, "Pagination / Page " + label, null, null, 36, 36, {
          fills: [solid(active ? PALETTE.primary : PALETTE.white)],
          strokes: active ? [] : outline(PALETTE.inputBorder),
          radius: 6,
        });
        setLayout(box, { dir: "row", justifyContent: "center", alignItems: "center" });
        addText(box, label, null, null, {
          size: 13,
          weight: active ? 700 : 500,
          color: active ? PALETTE.white : PALETTE.text,
        });
      });
      const next = instance("buttonSecondary");
      controls.appendChild(next);
      overrideFirstText(next, "Next");
      await registerComponent("pagination", pagination);
    }

    async function buildEmptyState() {
      const slot = nextSlot(400, 340);
      const empty = makeBoard(null, "Empty State", slot.x, slot.y, 400, 340, { fills: [] });
      setLayout(empty, {
        dir: "column",
        horizontalPadding: 32,
        verticalPadding: 32,
        rowGap: 12,
        alignItems: "center",
        verticalSizing: "auto",
      });

      // Illustration: circle, card with two bars, and a plus badge.
      const illustration = makeBoard(empty, "Empty State / Illustration", null, null, 160, 120, { fills: [] });
      addEllipse(illustration, 20, 0, 120, 120, { fills: [solid(PALETTE.primaryTint)] });
      addRect(illustration, 44, 32, 72, 56, {
        fills: [solid(PALETTE.white)],
        strokes: outline(PALETTE.border),
        radius: 8,
        shadows: [dropShadow(2, 6, 0.08)],
      });
      addRect(illustration, 60, 48, 40, 6, { fills: [solid(PALETTE.toggleOff)], radius: 3 });
      addRect(illustration, 60, 60, 40, 6, { fills: [solid(PALETTE.toggleOff)], radius: 3 });
      addEllipse(illustration, 102, 18, 28, 28, { fills: [solid(PALETTE.primary)] });
      addIcon(illustration, "M12 5v14M5 12h14", 108, 24, {
        size: 16,
        color: PALETTE.white,
        strokeWidth: 2.5,
      });

      addText(empty, "No projects yet", null, null, {
        size: 18,
        weight: 700,
        color: PALETTE.text,
        align: "center",
        width: 336,
        height: 26,
      });
      addText(empty, "Create a project to start tracking work with your team.", null, null, {
        size: 14,
        color: PALETTE.muted,
        align: "center",
        width: 336,
        height: 20,
        grow: "auto-height",
      });
      const cta = instance("buttonPrimary");
      empty.appendChild(cta);
      overrideFirstText(cta, "Create project");
      await registerComponent("emptyState", empty);
    }

    async function buildLoginForm() {
      const slot = nextSlot(400, 520);
      const form = makeBoard(null, "Login Form", slot.x, slot.y, 400, 520, {
        fills: [solid(PALETTE.white)],
        radius: 16,
        shadows: [dropShadow(24, 48, 0.16)],
      });
      setLayout(form, {
        dir: "column",
        horizontalPadding: 40,
        verticalPadding: 40,
        rowGap: 20,
        alignItems: "start",
        verticalSizing: "auto",
      });

      const logo = makeBoard(form, "Login Form / Logo", null, null, 120, 28, { fills: [] });
      setLayout(logo, {
        dir: "row",
        columnGap: 10,
        alignItems: "center",
        horizontalSizing: "auto",
        verticalSizing: "auto",
      });
      addIcon(logo, LOGO_PATH, null, null, { size: 24, fill: PALETTE.primary, color: "none" });
      addText(logo, "Acme", null, null, { size: 18, weight: 700, color: PALETTE.text });

      addText(form, "Sign in to your account", null, null, {
        size: 22,
        weight: 700,
        color: PALETTE.text,
        width: 320,
        height: 30,
        grow: "auto-height",
      });
      addText(form, "Welcome back. Enter your details below.", null, null, {
        size: 14,
        color: PALETTE.muted,
        width: 320,
        height: 20,
        grow: "auto-height",
      });

      const email = instance("input");
      form.appendChild(email);
      overrideTexts(email, ["Email", "you@company.com"]);
      const password = instance("input");
      form.appendChild(password);
      overrideTexts(password, ["Password", "••••••••"]);

      const options = makeBoard(form, "Login Form / Options", null, null, 320, 20, { fills: [] });
      setLayout(options, { dir: "row", justifyContent: "space-between", alignItems: "center" });
      options.appendChild(instance("checkbox"));
      addText(options, "Forgot password?", null, null, { size: 14, color: PALETTE.primary });

      const signIn = instance("buttonPrimary");
      form.appendChild(signIn);
      overrideFirstText(signIn, "Sign in");
      attempt(() => signIn.resize(320, 40));

      addText(form, "Don't have an account? Sign up", null, null, {
        size: 13,
        color: PALETTE.muted,
        align: "center",
        width: 320,
        height: 20,
      });
      await registerComponent("loginForm", form);
    }

    async function buildDetailHeader() {
      const slot = nextSlot(1132, 96);
      const header = makeBoard(null, "Detail Header", slot.x, slot.y, 1132, 96, {
        fills: [solid(PALETTE.white)],
        strokes: outline(PALETTE.border),
        radius: 12,
      });
      setLayout(header, {
        dir: "row",
        horizontalPadding: 24,
        alignItems: "center",
        justifyContent: "space-between",
      });

      // Left: avatar, title and meta row.
      const identity = makeBoard(header, "Detail Header / Identity", null, null, 600, 60, { fills: [] });
      setLayout(identity, {
        dir: "row",
        columnGap: 16,
        alignItems: "center",
        horizontalSizing: "auto",
        verticalSizing: "auto",
      });
      identity.appendChild(instance("avatar"));
      const titles = makeBoard(identity, "Detail Header / Title", null, null, 400, 60, { fills: [] });
      setLayout(titles, {
        dir: "column",
        rowGap: 4,
        alignItems: "start",
        horizontalSizing: "auto",
        verticalSizing: "auto",
      });
      addText(titles, "Acme Corporation", null, null, { size: 24, weight: 700, color: PALETTE.text });
      const meta = makeBoard(titles, "Detail Header / Meta", null, null, 400, 20, { fills: [] });
      setLayout(meta, {
        dir: "row",
        columnGap: 12,
        alignItems: "center",
        horizontalSizing: "auto",
        verticalSizing: "auto",
      });
      ["Enterprise", "·", "San Francisco, CA", "·", "Customer since 2019"].forEach((label) => {
        addText(meta, label, null, null, { size: 13, color: PALETTE.muted });
      });
      const status = instance("badgeSuccess");
      meta.appendChild(status);
      overrideFirstText(status, "Active");

      // Right: three actions.
      const actions = makeBoard(header, "Detail Header / Actions", null, null, 384, 40, { fills: [] });
      setLayout(actions, {
        dir: "row",
        columnGap: 12,
        alignItems: "center",
        horizontalSizing: "auto",
        verticalSizing: "auto",
      });
      const share = instance("buttonSecondary");
      actions.appendChild(share);
      overrideFirstText(share, "Share");
      const edit = instance("buttonSecondary");
      actions.appendChild(edit);
      overrideFirstText(edit, "Edit");
      const newDeal = instance("buttonPrimary");
      actions.appendChild(newDeal);
      overrideFirstText(newDeal, "New deal");
      await registerComponent("detailHeader", header);
    }

    async function buildActivityItem() {
      const slot = nextSlot(360, 60);
      const item = makeBoard(null, "Activity Item", slot.x, slot.y, 360, 60, {
        fills: [solid(PALETTE.white)],
        strokes: bottomOutline(PALETTE.border),
      });
      setLayout(item, {
        dir: "row",
        horizontalPadding: 8,
        verticalPadding: 8,
        columnGap: 12,
        alignItems: "start",
        verticalSizing: "auto",
      });
      item.appendChild(instance("avatar"));
      const body = makeBoard(item, "Activity Item / Body", null, null, 292, 40, { fills: [] });
      setLayout(body, { dir: "column", rowGap: 4, alignItems: "start", verticalSizing: "auto" });
      addText(body, "Jordan Lee moved Acme renewal to Negotiation", null, null, {
        size: 14,
        color: PALETTE.text,
        width: 292,
        height: 20,
        grow: "auto-height",
      });
      addText(body, "2 hours ago", null, null, { size: 12, color: PALETTE.muted });
      await registerComponent("activityItem", item);
    }

    async function buildNotificationPopover() {
      const slot = nextSlot(400, 420);
      const popover = makeBoard(null, "Notification Popover", slot.x, slot.y, 400, 420, {
        fills: [solid(PALETTE.white)],
        strokes: outline(PALETTE.border),
        radius: 12,
        shadows: [dropShadow(16, 40, 0.18), dropShadow(2, 6, 0.06)],
      });
      setLayout(popover, {
        dir: "column",
        horizontalPadding: 20,
        verticalPadding: 20,
        rowGap: 4,
        alignItems: "start",
        verticalSizing: "auto",
      });
      const header = makeBoard(popover, "Notification Popover / Header", null, null, 360, 24, { fills: [] });
      setLayout(header, { dir: "row", justifyContent: "space-between", alignItems: "center" });
      addText(header, "Notifications", null, null, { size: 16, weight: 700, color: PALETTE.text });
      addText(header, "Mark all as read", null, null, { size: 13, color: PALETTE.primary });
      ACTIVITY_LINES.slice(0, 5).forEach(([initials, message, time]) => {
        const row = instance("activityItem");
        popover.appendChild(row);
        overrideTexts(row, [initials, message, time]);
      });
      await registerComponent("notificationPopover", popover);
    }

    async function buildDatePicker() {
      const slot = nextSlot(304, 356);
      const picker = makeBoard(null, "Date Picker", slot.x, slot.y, 304, 356, {
        fills: [solid(PALETTE.white)],
        strokes: outline(PALETTE.border),
        radius: 12,
        shadows: [dropShadow(12, 32, 0.16), dropShadow(2, 6, 0.06)],
      });
      addIcon(picker, "M15 18l-6-6 6-6", 16, 18, { size: 16, color: PALETTE.muted });
      addIcon(picker, "M9 6l6 6-6 6", 272, 18, { size: 16, color: PALETTE.muted });
      addText(picker, "March 2026", 0, 18, {
        size: 14,
        weight: 700,
        color: PALETTE.text,
        align: "center",
        width: 304,
        height: 20,
      });
      ["M", "T", "W", "T", "F", "S", "S"].forEach((letter, i) => {
        addText(picker, letter, 26 + i * 36, 52, {
          size: 11,
          weight: 600,
          color: PALETTE.muted,
          align: "center",
          width: 36,
          height: 16,
        });
      });

      const cellX = (i) => 26 + (i % 7) * 36;
      const cellY = (i) => 76 + Math.floor(i / 7) * 36;
      const SELECTED = 19; // March 14
      // Range 15-18 sits behind the day numbers.
      MARCH_GRID.forEach((cell, i) => {
        if (i > SELECTED && i <= SELECTED + 4) {
          addRect(picker, cellX(i), cellY(i) + 2, 36, 32, { fills: [solid(PALETTE.primaryTint)] });
        }
      });
      addEllipse(picker, cellX(SELECTED) + 2, cellY(SELECTED) + 2, 32, 32, {
        fills: [solid(PALETTE.primary)],
      });
      MARCH_GRID.forEach((cell, i) => {
        const selected = i === SELECTED;
        addText(picker, String(cell.day), cellX(i), cellY(i) + 10, {
          size: 13,
          weight: selected ? 700 : 400,
          color: selected ? PALETTE.white : cell.inMonth ? PALETTE.text : PALETTE.muted,
          align: "center",
          width: 36,
          height: 16,
        });
      });

      const footer = makeBoard(picker, "Date Picker / Footer", 0, 292, 304, 64, { fills: [] });
      setLayout(footer, {
        dir: "row",
        horizontalPadding: 16,
        columnGap: 8,
        alignItems: "center",
        justifyContent: "end",
      });
      const clear = instance("buttonGhost");
      footer.appendChild(clear);
      overrideFirstText(clear, "Clear");
      const apply = instance("buttonPrimary");
      footer.appendChild(apply);
      overrideFirstText(apply, "Apply");
      await registerComponent("datePicker", picker);
    }

    async function buildInfoCard() {
      const slot = nextSlot(342, 200);
      const card = makeBoard(null, "Info Card", slot.x, slot.y, 342, 200, {
        fills: [solid(PALETTE.white)],
        strokes: outline(PALETTE.border),
        radius: 12,
      });
      setLayout(card, {
        dir: "column",
        horizontalPadding: 20,
        verticalPadding: 20,
        rowGap: 12,
        alignItems: "start",
        verticalSizing: "auto",
      });
      addText(card, "Company", null, null, { size: 15, weight: 700, color: PALETTE.text });
      [
        ["Industry", "Software"],
        ["Employees", "1,200"],
        ["Plan", "Enterprise"],
        ["Owner", "Jordan Lee"],
      ].forEach(([label, value]) => {
        const row = makeBoard(card, "Info Card / Row", null, null, 302, 20, { fills: [] });
        setLayout(row, { dir: "row", justifyContent: "space-between", alignItems: "center" });
        addText(row, label, null, null, { size: 13, color: PALETTE.muted });
        addText(row, value, null, null, { size: 13, weight: 500, color: PALETTE.text });
      });
      await registerComponent("infoCard", card);
    }

    async function buildDesignSystem() {
      await buildAvatar();
      await buildBadges();
      await buildButtons();
      await buildInput();
      await buildCheckbox();
      await buildToggle();
      await buildTableHeaderCell();
      await buildTableRow();
      await buildTable();
      await buildCard();
      await buildChartCard();
      await buildModal();
      await buildWizard();
      await buildNavBar();
      await buildSidebar();
      await buildToast();
      await buildStatTile();

      // Components added later draw from their own random stream. Saved and
      // restored by hand: withStream would restore it at the first await.
      const previousRandom = activeRandom;
      activeRandom = extraRandom;
      try {
        await buildTabs();
        await buildDropdownMenu();
        await buildTooltip();
        await buildKanbanCard();
        await buildKanbanColumn();
        await buildCalendar();
        await buildBreadcrumbs();
        await buildPagination();
        await buildEmptyState();
        await buildLoginForm();
        await buildDetailHeader();
        await buildActivityItem();
        await buildNotificationPopover();
        await buildDatePicker();
        await buildInfoCard();
      } finally {
        activeRandom = previousRandom;
      }
    }

    // ---------------------------------------------------------------
    // b. Screen composition (instances only)
    // ---------------------------------------------------------------
    // Board name for a kind. Slashes would make layer paths, so drop them.
    function screenLabel(kind) {
      return kind.replace(" / ", " ");
    }

    function screenHeight(kind) {
      return SCREEN_HEIGHTS[kind] || SCREEN_H;
    }

    function createScreenAt(kind, name, x, y) {
      return makeBoard(null, name, x, y, SCREEN_W, screenHeight(kind), {
        fills: [solid(PALETTE.white)],
        clip: true,
      });
    }

    function createScreen(kind, index) {
      const col = index % 6;
      const row = Math.floor(index / 6);
      const name = screenLabel(kind) + " " + String(index + 1).padStart(2, "0");
      return createScreenAt(kind, name, col * (SCREEN_W + 200), row * (screenHeight(kind) + 200));
    }

    // Adds an instance at (lx, ly) relative to the screen.
    function place(screen, key, lx, ly) {
      return placeIn(screen, instance(key), lx, ly);
    }

    function addOverlay(screen) {
      return addRect(screen, 0, 0, SCREEN_W, SCREEN_H, {
        name: "Overlay",
        fills: [solid(PALETTE.sidebar)],
        opacity: 0.4,
      });
    }

    function placeModal(screen) {
      const modal = place(screen, "modal", (SCREEN_W - 560) / 2, 0);
      modal.y = screen.y + (SCREEN_H - heightOf(modal, 330)) / 2;
      return modal;
    }

    function tableHeight() {
      return TABLE_HEADER_H + config.tableRows * TABLE_ROW_H;
    }

    function composeDashboard(screen) {
      place(screen, "navBar", 0, 0);
      place(screen, "sidebar", 0, NAV_H);
      spread(CONTENT_X0, CONTENT_X1, 280, 4).forEach((x) => place(screen, "statTile", x, 88));
      spread(CONTENT_X0, CONTENT_X1, 360, 3).forEach((x) => place(screen, "chartCard", x, 248));
      spread(CONTENT_X0, CONTENT_X1, 328, 3).forEach((x) => place(screen, "card", x, 552));
      place(screen, "table", CONTENT_X0, 896);
      if (chance(1 / 3)) place(screen, "toast", CONTENT_X1 - 380, 940);
    }

    function composeUsers(screen) {
      place(screen, "navBar", 0, 0);
      place(screen, "sidebar", 0, NAV_H);
      place(screen, "table", CONTENT_X0, 88);
      if (chance(0.5)) place(screen, "table", CONTENT_X0, 88 + tableHeight() + 24);
      if (chance(1 / 3)) {
        addOverlay(screen);
        placeModal(screen);
      }
    }

    function composeWizards(screen) {
      place(screen, "navBar", 0, 0);
      const wizard = place(screen, "wizard", (SCREEN_W - TABLE_W) / 2, 96);
      const wizardBottom = 96 + heightOf(wizard, 560);
      spread(24, SCREEN_W - 24, 328, 3).forEach((x) => place(screen, "card", x, wizardBottom + 40));
      if (chance(1 / 3)) {
        addOverlay(screen);
        placeModal(screen);
      }
    }

    function composeSettings(screen) {
      place(screen, "navBar", 0, 0);
      place(screen, "sidebar", 0, NAV_H);
      const titles = ["Profile", "Notifications", "Security", "Billing"];
      let y = 88;
      let sections = 0;
      while (y < 900 && sections < 3) {
        addText(screen, titles[sections % titles.length], CONTENT_X0, y, {
          size: 20,
          weight: 700,
          color: PALETTE.text,
        });

        const inputCount = int(6, 10);
        const inputTop = y + 40;
        for (let k = 0; k < inputCount; k += 1) {
          const field = place(screen, "input", CONTENT_X0 + (k % 2) * 320, inputTop + Math.floor(k / 2) * 84);
          overrideFirstText(field, pick(FIELD_LABELS));
        }
        y = inputTop + Math.ceil(inputCount / 2) * 84 + 8;

        const toggleCount = int(1, 2);
        for (let t = 0; t < toggleCount; t += 1) {
          place(screen, "toggle", CONTENT_X0, y);
          y += 32;
        }
        const checkboxCount = int(1, 2);
        for (let c = 0; c < checkboxCount; c += 1) {
          place(screen, "checkbox", CONTENT_X0, y);
          y += 28;
        }

        const footer = makeBoard(screen, "Settings / Footer", CONTENT_X0, y + 8, CONTENT_X1 - CONTENT_X0, 40, {
          fills: [],
        });
        setLayout(footer, { dir: "row", justifyContent: "end", columnGap: 12, alignItems: "center" });
        const cancel = instance("buttonSecondary");
        footer.appendChild(cancel);
        overrideFirstText(cancel, "Cancel");
        const save = instance("buttonPrimary");
        footer.appendChild(save);
        overrideFirstText(save, "Save changes");

        y += 96;
        sections += 1;
      }
    }

    function composeLoginOnboarding(screen) {
      if (chance(0.5)) {
        addRect(screen, 0, 0, SCREEN_W, LOGIN_H, {
          name: "Background",
          fills: linearGradient("#4F46E5", "#0EA5E9"),
        });
        const form = place(screen, "loginForm", (SCREEN_W - 400) / 2, 0);
        form.y = screen.y + (LOGIN_H - heightOf(form, 520)) / 2;
        addText(screen, "© 2026 Acme Inc. · Privacy · Terms", 0, 980, {
          size: 12,
          color: PALETTE.white,
          align: "center",
          width: SCREEN_W,
          height: 16,
        });
        return;
      }

      addRect(screen, 0, 0, SCREEN_W, LOGIN_H, {
        name: "Background",
        fills: linearGradient("#EEF2FF", "#E0F2FE"),
      });
      addIcon(screen, LOGO_PATH, 40, 32, { size: 24, fill: PALETTE.primary, color: "none" });
      addText(screen, "Acme", 72, 34, { size: 16, weight: 700, color: PALETTE.text });
      addText(screen, "Set up your workspace", 0, 96, {
        size: 28,
        weight: 700,
        color: PALETTE.text,
        align: "center",
        width: SCREEN_W,
        height: 36,
      });
      addText(screen, "Five quick steps and your team is ready to work.", 0, 140, {
        size: 15,
        color: PALETTE.muted,
        align: "center",
        width: SCREEN_W,
        height: 22,
      });
      place(screen, "wizard", (SCREEN_W - TABLE_W) / 2, 200);
      addText(screen, "Step 3 of 5 · You can change these later in Settings", 0, 800, {
        size: 13,
        color: PALETTE.muted,
        align: "center",
        width: SCREEN_W,
        height: 20,
      });
    }

    function composeDetail(screen) {
      place(screen, "navBar", 0, 0);
      place(screen, "sidebar", 0, NAV_H);
      place(screen, "breadcrumbs", CONTENT_X0, 88);
      place(screen, "detailHeader", CONTENT_X0, 120);
      place(screen, "tabs", CONTENT_X0, 236);

      // Left column: activity feed.
      const activity = makeBoard(screen, "Activity", CONTENT_X0, 304, 400, 400, {
        fills: [solid(PALETTE.white)],
        strokes: outline(PALETTE.border),
        radius: 12,
      });
      setLayout(activity, {
        dir: "column",
        horizontalPadding: 20,
        verticalPadding: 20,
        rowGap: 4,
        alignItems: "start",
        verticalSizing: "auto",
      });
      addText(activity, "Activity", null, null, { size: 16, weight: 700, color: PALETTE.text });
      // Two-line rows at about 84 px each: 12 rows end near y=1380, inside the 1400 px screen.
      const itemCount = int(8, 12);
      for (let k = 0; k < itemCount; k += 1) {
        const item = instance("activityItem");
        activity.appendChild(item);
        const [initials, message, time] = pick(ACTIVITY_LINES);
        overrideTexts(item, [initials, message, time]);
      }

      // Right column: 2 x 3 info cards.
      INFO_CARD_TITLES.forEach((title, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        const card = place(screen, "infoCard", CONTENT_X0 + 424 + col * 366, 304 + row * 240);
        overrideFirstText(card, title);
      });
    }

    function composeKanban(screen) {
      place(screen, "navBar", 0, 0);
      place(screen, "sidebar", 0, NAV_H);
      addText(screen, "Sprint 24", CONTENT_X0, 88, { size: 24, weight: 700, color: PALETTE.text });
      const filter = place(screen, "buttonSecondary", CONTENT_X1 - 120 - 12 - 120, 84);
      overrideFirstText(filter, "Filter");
      const newTask = place(screen, "buttonPrimary", CONTENT_X1 - 120, 84);
      overrideFirstText(newTask, "New task");

      const titles = ["Backlog", "To do", "In progress", "Review", "Done"];
      const tags = ["Backend", "Frontend", "Design", "Bug", "Infra", "Docs", "Security", "Mobile"];
      const tasks = [
        "Migrate billing service to new API",
        "Add SSO login for enterprise teams",
        "Fix timezone bug in weekly report",
        "Redesign onboarding checklist",
        "Rate limit public webhooks",
        "Export invoices as CSV",
        "Audit role permissions",
        "Speed up customer search",
        "Dark mode for the dashboard",
        "Retry failed payment jobs",
      ];
      spread(CONTENT_X0, CONTENT_X1, 216, 5).forEach((x, i) => {
        const column = place(screen, "kanbanColumn", x, 144);
        // Texts in order: column title, count, then tag / task / meta per card.
        const values = [titles[i], String(int(2, 12))];
        for (let c = 0; c < 6; c += 1) {
          values.push(pick(tags), pick(tasks), "Apr " + int(1, 30) + " · " + int(0, 9) + " comments");
        }
        overrideTexts(column, values);
      });
    }

    function composeCalendar(screen) {
      place(screen, "navBar", 0, 0);
      place(screen, "sidebar", 0, NAV_H);
      addText(screen, "Calendar", CONTENT_X0, 88, { size: 24, weight: 700, color: PALETTE.text });
      const newEvent = place(screen, "buttonPrimary", CONTENT_X1 - 120, 84);
      overrideFirstText(newEvent, "New event");
      place(screen, "calendar", CONTENT_X0, 144);

      // Side list: date picker, then upcoming events.
      const sideX = CONTENT_X0 + 728 + 24;
      place(screen, "datePicker", sideX, 144);
      const upcomingTop = 144 + 356 + 24;
      addText(screen, "Upcoming", sideX, upcomingTop, { size: 16, weight: 700, color: PALETTE.text });
      let y = upcomingTop + 32;
      EVENT_LINES.forEach(([initials, title, time]) => {
        const item = place(screen, "activityItem", sideX, y);
        overrideTexts(item, [initials, title, time]);
        y += heightOf(item, 60) + 8;
      });
    }

    function composeReports(screen) {
      place(screen, "navBar", 0, 0);
      place(screen, "sidebar", 0, NAV_H);
      addText(screen, "Reports", CONTENT_X0, 88, { size: 24, weight: 700, color: PALETTE.text });
      const range = place(screen, "buttonSecondary", CONTENT_X1 - 120 - 12 - 120, 84);
      overrideFirstText(range, "Last 30 days");
      const exportBtn = place(screen, "buttonPrimary", CONTENT_X1 - 120, 84);
      overrideFirstText(exportBtn, "Export");

      const titles = ["Revenue", "Active users", "Churn", "Signups", "Tickets", "NPS"];
      spread(CONTENT_X0, CONTENT_X1, 360, 3).forEach((x, i) => {
        const card = place(screen, "chartCard", x, 144);
        overrideFirstText(card, titles[i]);
      });
      spread(CONTENT_X0, CONTENT_X1, 360, 3).forEach((x, i) => {
        const card = place(screen, "chartCard", x, 448);
        overrideFirstText(card, titles[3 + i]);
      });

      place(screen, "table", CONTENT_X0, 752);
      place(screen, "pagination", CONTENT_X0, 752 + tableHeight() + 16);
    }

    // Adds an optional popup on top of the screen (about 30% of screens) and
    // appends its label to the screen name. Callers pick the random stream.
    function addPopup(screen, kind) {
      if (!chance(0.3)) return null;
      // A modal is already open on this screen; no popup on top of its overlay.
      if ((screen.children || []).some((child) => child.name === "Overlay")) return null;
      const onLogin = kind === "Login / Onboarding";
      let choice = pick(["dropdown", "tooltip", "notification", "datePicker"]);
      if (onLogin && choice === "notification") choice = "tooltip";
      if (onLogin && choice === "datePicker") choice = "dropdown";

      let shape = null;
      let label = "";
      if (choice === "dropdown") {
        shape = onLogin
          ? place(screen, "dropdownMenu", SCREEN_W - 280, 72)
          : place(screen, "dropdownMenu", SCREEN_W - 24 - 240, 60);
        label = "Dropdown open";
      } else if (choice === "tooltip") {
        shape = onLogin
          ? place(screen, "tooltip", (SCREEN_W - 168) / 2, 600)
          : place(screen, "tooltip", 140, NAV_H + 24 + 36 * 2 - 40);
        label = "Tooltip";
      } else if (choice === "notification") {
        shape = place(screen, "notificationPopover", SCREEN_W - 24 - 400 - 56, 60);
        label = "Notifications open";
      } else {
        shape = place(screen, "datePicker", CONTENT_X0 + 200, 128);
        label = "Date picker open";
      }
      set(screen, "name", String(screen.name || "") + " · " + label);
      return shape;
    }

    const COMPOSERS = {
      Dashboard: composeDashboard,
      Users: composeUsers,
      Wizards: composeWizards,
      Settings: composeSettings,
      "Login / Onboarding": composeLoginOnboarding,
      Detail: composeDetail,
      Kanban: composeKanban,
      Calendar: composeCalendar,
      Reports: composeReports,
    };

    // ---------------------------------------------------------------
    // Enterprise app page and progress helpers
    // ---------------------------------------------------------------
    const ENTERPRISE_TITLES = {
      Dashboard: "Dashboard",
      Users: "Users & Teams",
      Wizards: "Billing setup",
      Settings: "Settings",
      "Login / Onboarding": "Authentication",
      Detail: "Customers",
      Kanban: "Projects",
      Calendar: "Calendar",
      Reports: "Reports",
    };
    const SECTION_COLUMNS = 3; // sections per row on the map
    const SCREEN_COLUMNS = 6; // screens per row inside a section
    const SECTION_GAP = 600;
    const MAP_TOP = 1400;

    // Progress total for this run. Init and count build no screens.
    let totalScreens = 0;
    if (mode === "full") totalScreens = config.screenPages * config.screensPerPage + config.singlePageScreens;
    if (mode === "append") totalScreens = config.appendScreens;
    let screensBuilt = 0;

    // Penpot persists changes only after they stop arriving for a while, so a
    // plugin that never pauses keeps every change in the tab until it runs
    // out of memory. Pause every few screens so each batch is saved.
    const SAVE_PAUSE_EVERY = params.savePauseEvery || 10;
    const SAVE_PAUSE_MS = params.savePauseMs || 10000;

    // Counts a finished screen, logs progress every 25, yields every 5 and
    // pauses for a save every SAVE_PAUSE_EVERY screens.
    async function noteScreenBuilt() {
      screensBuilt += 1;
      if (screensBuilt % 25 === 0) {
        console.log("[large-design] progress " + screensBuilt + "/" + totalScreens + " screens");
      }
      if (typeof setTimeout !== "function") {
        return;
      }
      if (screensBuilt % SAVE_PAUSE_EVERY === 0) {
        await new Promise((resolve) => setTimeout(resolve, SAVE_PAUSE_MS));
      } else if (screensBuilt % 5 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    // Fisher-Yates shuffle using the active random stream.
    function shuffle(items) {
      const out = items.slice();
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = int(0, i);
        const tmp = out[i];
        out[i] = out[j];
        out[j] = tmp;
      }
      return out;
    }

    // One kind per screen. Batches of all kinds are appended in shuffled order;
    // a batch that would start with the previous kind gets its first item swapped.
    function assignEnterpriseKinds(total) {
      const sequence = [];
      while (sequence.length < total) {
        const batch = shuffle(SCREEN_KINDS);
        const last = sequence.length > 0 ? sequence[sequence.length - 1] : null;
        if (batch[0] === last) {
          const swapWith = int(1, batch.length - 1);
          const tmp = batch[0];
          batch[0] = batch[swapWith];
          batch[swapWith] = tmp;
        }
        batch.forEach((kind) => sequence.push(kind));
      }
      return sequence.slice(0, total);
    }

    // Builds the "Enterprise app" map page, one section per kind. Every random
    // draw here uses enterpriseRandom. Returns the number of screens built.
    async function buildEnterpriseApp(total) {
      const previous = activeRandom;
      activeRandom = enterpriseRandom;
      try {
        const sequence = assignEnterpriseKinds(total);
        const sections = SCREEN_KINDS.map((kind) => ({ kind, screens: [] }));
        sequence.forEach((kind, index) => {
          sections[SCREEN_KINDS.indexOf(kind)].screens.push(index);
        });
        const activeSections = sections.filter((section) => section.screens.length > 0);

        // Only as many columns as the fullest section needs, so sparse maps stay
        // compact, but at least 3 so a 400 px section title fits its section.
        const fullest = Math.max(...activeSections.map((s) => s.screens.length));
        const usedColumns = Math.max(3, Math.min(SCREEN_COLUMNS, fullest));
        const sectionWidth = usedColumns * (SCREEN_W + 200) - 200;
        const colStep = SCREEN_W + 200;
        let rowTop = MAP_TOP;
        let rowBottom = 0;
        let built = 0;

        addText(null, "Acme Enterprise — app map", 0, 0, {
          size: 640,
          weight: 700,
          color: PALETTE.text,
        });
        addText(null, total + " screens · " + activeSections.length + " sections", 0, 760, {
          size: 240,
          color: PALETTE.muted,
        });

        for (let k = 0; k < activeSections.length; k += 1) {
          const section = activeSections[k];
          const col = k % SECTION_COLUMNS;
          if (k > 0 && col === 0) {
            rowTop = rowBottom + SECTION_GAP;
            rowBottom = 0;
          }
          const sectionX = col * (sectionWidth + SECTION_GAP);
          const sectionY = rowTop;
          const height = screenHeight(section.kind);
          const rows = Math.ceil(section.screens.length / usedColumns);
          // Screens start 1000 px below the section title, leaving room for the
          // count line and Penpot's board name labels at low zoom.
          rowBottom = Math.max(rowBottom, sectionY + 1000 + rows * (height + 200) - 200);

          addText(null, ENTERPRISE_TITLES[section.kind], sectionX, sectionY, {
            size: 400,
            weight: 700,
            color: PALETTE.text,
          });
          const countLabel = section.screens.length + (section.screens.length === 1 ? " screen" : " screens");
          addText(null, countLabel, sectionX, sectionY + 480, {
            size: 160,
            color: PALETTE.muted,
          });

          for (let j = 0; j < section.screens.length; j += 1) {
            const x = sectionX + (j % usedColumns) * colStep;
            const y = sectionY + 1000 + Math.floor(j / usedColumns) * (height + 200);
            const name = screenLabel(section.kind) + " " + String(j + 1).padStart(2, "0");
            const screen = createScreenAt(section.kind, name, x, y);
            COMPOSERS[section.kind](screen);
            addPopup(screen, section.kind);
            built += 1;
            await noteScreenBuilt();
          }
        }
        return built;
      } finally {
        activeRandom = previous;
      }
    }

    // ---------------------------------------------------------------
    // Incremental build ("init", "append", "count")
    // ---------------------------------------------------------------
    const ENTERPRISE_PAGE_NAME = "Enterprise app";
    const LAYOUT_PLUGIN_NS = "large-design";

    // DS key -> board name passed to makeBoard in the builders above.
    const COMPONENT_NAMES = {
      avatar: "Avatar",
      badgePrimary: "Badge / Primary",
      badgeSuccess: "Badge / Success",
      badgeWarning: "Badge / Warning",
      badgeDanger: "Badge / Danger",
      buttonPrimary: "Button / Primary",
      buttonSecondary: "Button / Secondary",
      buttonGhost: "Button / Ghost",
      input: "Input",
      checkbox: "Checkbox",
      toggle: "Toggle",
      tableHeaderCell: "Table / Header Cell",
      tableRow: "Table / Row",
      table: "Table",
      card: "Card",
      chartCard: "Chart Card",
      modal: "Modal",
      wizard: "Wizard",
      navBar: "NavBar",
      sidebar: "Sidebar",
      toast: "Toast",
      statTile: "Stat Tile",
      tabs: "Tabs",
      dropdownMenu: "Dropdown Menu",
      tooltip: "Tooltip",
      kanbanCard: "Kanban / Card",
      kanbanColumn: "Kanban / Column",
      calendar: "Calendar",
      breadcrumbs: "Breadcrumbs",
      pagination: "Pagination",
      emptyState: "Empty State",
      loginForm: "Login Form",
      detailHeader: "Detail Header",
      activityItem: "Activity Item",
      notificationPopover: "Notification Popover",
      datePicker: "Date Picker",
      infoCard: "Info Card",
    };

    // Layout that does not depend on how many screens exist yet, so every batch
    // places its screens in the same spots. Section rows are sized for capacity.
    function fixedMapLayout(capacity) {
      const colStep = SCREEN_W + 200;
      const sectionWidth = SCREEN_COLUMNS * colStep - 200;
      const perKindCap = Math.ceil(capacity / SCREEN_KINDS.length);
      const rowsCap = Math.max(1, Math.ceil(perKindCap / SCREEN_COLUMNS));
      const sectionRowCount = Math.ceil(SCREEN_KINDS.length / SECTION_COLUMNS);

      // rowTops[r] is the top y of section row r.
      const rowTops = [MAP_TOP];
      for (let r = 0; r < sectionRowCount; r += 1) {
        let tallest = 0;
        for (let c = 0; c < SECTION_COLUMNS; c += 1) {
          const kind = SCREEN_KINDS[r * SECTION_COLUMNS + c];
          if (kind) tallest = Math.max(tallest, screenHeight(kind));
        }
        const height = 1000 + rowsCap * (tallest + 200) - 200;
        rowTops[r + 1] = rowTops[r] + height + SECTION_GAP;
      }

      const sectionOrigin = (kind) => {
        const s = SCREEN_KINDS.indexOf(kind);
        return {
          x: (s % SECTION_COLUMNS) * (sectionWidth + SECTION_GAP),
          y: rowTops[Math.floor(s / SECTION_COLUMNS)],
        };
      };

      const screenPosition = (kind, j) => {
        const origin = sectionOrigin(kind);
        return {
          x: origin.x + (j % SCREEN_COLUMNS) * colStep,
          y: origin.y + 1000 + Math.floor(j / SCREEN_COLUMNS) * (screenHeight(kind) + 200),
        };
      };

      return { sectionOrigin, screenPosition, perKindCap };
    }

    // Adds a text to the current page under a stable layer name.
    function createMapText(name, content, x, y, options) {
      const text = addText(null, content, x, y, options);
      if (text) set(text, "name", name);
      return text;
    }

    function screenCountLabel(n) {
      return n + (n === 1 ? " screen" : " screens");
    }

    // Titles, counts and subtitle of the map page. Also stores the capacity on the page.
    function writeMapTexts(page, capacity) {
      const layout = fixedMapLayout(capacity);
      createMapText("Map / Title", "Acme Enterprise — app map", 0, 0, {
        size: 640,
        weight: 700,
        color: PALETTE.text,
      });
      createMapText("Map / Subtitle", "0 screens · " + SCREEN_KINDS.length + " sections", 0, 760, {
        size: 240,
        color: PALETTE.muted,
      });
      SCREEN_KINDS.forEach((kind) => {
        const origin = layout.sectionOrigin(kind);
        createMapText("Section / " + kind + " / Title", ENTERPRISE_TITLES[kind], origin.x, origin.y, {
          size: 400,
          weight: 700,
          color: PALETTE.text,
        });
        createMapText("Section / " + kind + " / Count", "0 screens", origin.x, origin.y + 480, {
          size: 160,
          color: PALETTE.muted,
        });
      });
      attempt(() => {
        page.setSharedPluginData(LAYOUT_PLUGIN_NS, "layout", JSON.stringify({ version: 1, capacity: capacity }));
      });
    }

    function rootChildren(page) {
      return (page.root && page.root.children) || [];
    }

    function rootBoards(page) {
      return rootChildren(page).filter((s) => s.type === "board");
    }

    // The current page when it is the map page, else the first file page with that name.
    function findEnterprisePage() {
      const current = penpot.currentPage;
      if (current && current.name === ENTERPRISE_PAGE_NAME) return current;
      const pages = Array.from(penpot.currentFile.pages || []);
      return pages.find((p) => p.name === ENTERPRISE_PAGE_NAME) || null;
    }

    async function openPageIfNeeded(page) {
      const current = penpot.currentPage;
      if (!current || current.id !== page.id) await penpot.openPage(page);
    }

    // Renames the first page to "Design System" (or creates one) and opens it.
    async function openDesignSystemPage() {
      let page = null;
      try {
        page = penpot.currentFile.pages[0];
        page.name = "Design System";
      } catch (err) {
        page = penpot.createPage();
        page.name = "Design System";
      }
      await penpot.openPage(page);
      return page;
    }

    // Kind for each screen index 0..length-1 of one long run. The stream starts
    // fresh on every call, so kindSequence(n) is a prefix of kindSequence(m).
    function kindSequence(length) {
      const stream = mulberry32((config.seed ^ 0x2545f491) >>> 0);
      return withStream(stream, () => assignEnterpriseKinds(length));
    }

    // Random stream for one screen. Depends only on seed and the global index.
    function screenStream(index) {
      const base = Math.imul((config.seed ^ 0x85ebca6b) >>> 0, 0x27d4eb2d);
      return mulberry32((base + Math.imul(index + 1, 0x9e3779b1)) >>> 0);
    }

    function normaliseComponentName(value) {
      return String(value || "")
        .split("/")
        .map((p) => p.trim())
        .filter(Boolean)
        .join(" / ");
    }

    // Fills DS from the file's local library. Throws when a component is missing.
    function mapLibraryComponents() {
      const byName = new Map();
      Array.from(penpot.library.local.components || []).forEach((c) => {
        const full = normaliseComponentName((c.path ? c.path + " / " : "") + (c.name || ""));
        if (!byName.has(full)) byName.set(full, c);
      });
      const missing = [];
      Object.keys(COMPONENT_NAMES).forEach((key) => {
        const component = byName.get(normaliseComponentName(COMPONENT_NAMES[key]));
        if (component) DS[key] = component;
        else missing.push(COMPONENT_NAMES[key]);
      });
      if (missing.length > 0) {
        throw new Error("missing library components: " + missing.join(", "));
      }
      componentCount = Object.keys(DS).length;
    }

    // Mode "count": counts the screens on the map page. Builds nothing.
    async function runCountMode() {
      const page = findEnterprisePage();
      if (!page) {
        console.log("[large-design-warn] no Enterprise app page");
        console.log("[large-design] COUNT 0");
        console.log("[large-design] DONE " + JSON.stringify({ pages: [], screens: 0, count: 0 }));
        return;
      }
      await openPageIfNeeded(page);
      const count = rootBoards(page).length;
      console.log("[large-design] COUNT " + count);
      console.log(
        "[large-design] DONE " +
          JSON.stringify({ pages: [{ id: page.id, name: ENTERPRISE_PAGE_NAME }], screens: 0, count: count })
      );
    }

    // Mode "append": adds appendScreens screens after the ones already on the map page.
    async function runAppendMode() {
      mapLibraryComponents();
      collecting = THEMED;
      if (THEMED) await loadThemeTokens();

      let page = findEnterprisePage();
      if (!page) {
        page = penpot.createPage();
        page.name = ENTERPRISE_PAGE_NAME;
        await penpot.openPage(page);
        writeMapTexts(page, config.layoutCapacity);
      } else {
        await openPageIfNeeded(page);
      }

      // Capacity from the page when it was stored there, else the config value.
      let capacity = config.layoutCapacity;
      try {
        const stored = JSON.parse(page.getSharedPluginData(LAYOUT_PLUGIN_NS, "layout") || "null");
        if (stored && typeof stored.capacity === "number" && Number.isFinite(stored.capacity) && stored.capacity >= 1) {
          capacity = Math.floor(stored.capacity);
        }
      } catch (err) {
        console.log("[large-design-warn] " + String((err && err.message) || err));
      }
      const layout = fixedMapLayout(capacity);

      // Screens already on the page, per kind.
      const perKind = {};
      SCREEN_KINDS.forEach((kind) => {
        perKind[kind] = 0;
      });
      const start = rootBoards(page).length;
      rootBoards(page).forEach((board) => {
        const name = String(board.name || "");
        SCREEN_KINDS.forEach((kind) => {
          if (name.startsWith(screenLabel(kind) + " ")) perKind[kind] += 1;
        });
      });
      console.log("[large-design] append start " + start);

      const total = start + config.appendScreens;
      const sequence = kindSequence(total);
      const warned = {};
      let built = 0;
      for (let i = start; i < total; i += 1) {
        const kind = sequence[i];
        const j = perKind[kind];
        perKind[kind] += 1;
        if (j >= layout.perKindCap && !warned[kind]) {
          warned[kind] = true;
          console.log("[large-design-warn] section " + kind + " is over capacity");
        }
        const pos = layout.screenPosition(kind, j);
        const name = screenLabel(kind) + " " + String(j + 1).padStart(2, "0");
        const screen = createScreenAt(kind, name, pos.x, pos.y);
        withStream(screenStream(i), () => {
          COMPOSERS[kind](screen);
          addPopup(screen, kind);
        });
        built += 1;
        await noteScreenBuilt();
      }

      // Update the count texts and the subtitle. A missing text is created.
      const setMapText = (name, content, x, y, options) => {
        const existing = rootChildren(page).find((s) => s.type === "text" && s.name === name);
        if (existing) {
          set(existing, "characters", content);
          // Editing the characters can rename an auto-named layer, so set the name again.
          set(existing, "name", name);
        } else {
          createMapText(name, content, x, y, options);
        }
      };
      let kindsWithScreens = 0;
      SCREEN_KINDS.forEach((kind) => {
        if (perKind[kind] > 0) kindsWithScreens += 1;
        const origin = layout.sectionOrigin(kind);
        setMapText("Section / " + kind + " / Count", screenCountLabel(perKind[kind]), origin.x, origin.y + 480, {
          size: 160,
          color: PALETTE.muted,
        });
      });
      setMapText("Map / Subtitle", total + " screens · " + kindsWithScreens + " sections", 0, 760, {
        size: 240,
        color: PALETTE.muted,
      });

      await bindAllPages();
      console.log(
        "[large-design] DONE " +
          JSON.stringify({
            pages: [{ id: page.id, name: ENTERPRISE_PAGE_NAME }],
            screens: built,
            startIndex: start,
            endIndex: total,
            components: componentCount,
            themes: themingOn ? THEME_NAMES : undefined,
            bindings: bindingsApplied,
          })
      );
    }

    // ---------------------------------------------------------------
    // Verify theme mode (read-only)
    // ---------------------------------------------------------------
    // Checks that every shape with an applied colour token has, in params.theme,
    // the colour that token has in that theme. Changes nothing.
    function readVerifyInfo(shape) {
      const tokens = shape.tokens || {};
      const fill0 =
        Array.isArray(shape.fills) && shape.fills[0] && typeof shape.fills[0].fillColor === "string"
          ? shape.fills[0].fillColor
          : null;
      const stroke0 =
        Array.isArray(shape.strokes) && shape.strokes[0] && typeof shape.strokes[0].strokeColor === "string"
          ? shape.strokes[0].strokeColor
          : null;
      const entries = [];
      if (tokens.fill) entries.push({ attr: "fill", tokenName: tokens.fill, actual: fill0 });
      if (tokens.strokeColor) entries.push({ attr: "strokeColor", tokenName: tokens.strokeColor, actual: stroke0 });
      return {
        name: shape.name,
        id: shape.id,
        type: shape.type,
        colored: !!(fill0 || stroke0),
        bound: !!(tokens.fill || tokens.strokeColor),
        entries,
      };
    }

    async function runVerifyThemeMode() {
      const catalog = tokenCatalog();
      const themeName = typeof params.theme === "string" ? params.theme : "";
      const theme =
        Array.from(catalog.themes || []).find(
          (t) => t.name === themeName || t.group + " / " + t.name === themeName
        ) || null;
      if (!theme) throw new Error("no token theme named " + themeName);

      // Expected colour per token name in this theme. Later sets win.
      const expected = Object.create(null);
      Array.from(theme.activeSets || []).forEach((tokenSet) => {
        Array.from(tokenSet.tokens || []).forEach((token) => {
          if (typeof token.value === "string") expected[token.name] = token.value.toLowerCase();
        });
      });

      const activeThemes = Array.from(catalog.themes || [])
        .filter((t) => t.active === true)
        .map((t) => t.name);
      if (theme.active !== true) {
        console.log("[large-design-warn] theme " + themeName + " is not active; checking it anyway");
      }

      let checked = 0;
      let mismatched = 0;
      let colored = 0;
      let bound = 0;
      const examples = [];
      const perPage = [];
      const pages = Array.from(penpot.currentFile.pages || []);
      for (const page of pages) {
        const shapes = Array.from((await page.findShapes()) || []);
        let pageChecked = 0;
        let pageMismatched = 0;
        for (const shape of shapes) {
          let info = null;
          try {
            info = readVerifyInfo(shape);
          } catch (err) {
            info = null;
          }
          if (!info) continue;
          if (info.colored) colored += 1;
          if (info.bound) bound += 1;
          info.entries.forEach((entry) => {
            const want = expected[entry.tokenName];
            const got = (entry.actual || "").toLowerCase();
            checked += 1;
            pageChecked += 1;
            if (want === undefined || got !== want) {
              mismatched += 1;
              pageMismatched += 1;
              if (examples.length < 10) {
                examples.push({
                  page: page.name,
                  shape: info.name,
                  id: info.id,
                  type: info.type,
                  attr: entry.attr,
                  token: entry.tokenName,
                  expected: want === undefined ? null : want,
                  actual: entry.actual ? entry.actual.toLowerCase() : null,
                });
              }
            }
          });
        }
        console.log(
          "[large-design] verify page " + page.name + ": " + pageChecked + " checked, " +
            pageMismatched + " mismatched, " + shapes.length + " shapes"
        );
        perPage.push({
          id: page.id,
          name: page.name,
          shapes: shapes.length,
          checked: pageChecked,
          mismatched: pageMismatched,
        });
        await sleep(0);
      }

      examples.forEach((example) => {
        console.log("[large-design] VERIFY_MISMATCH " + JSON.stringify(example));
      });
      console.log(
        "[large-design] DONE " +
          JSON.stringify({
            pages: perPage.map((p) => ({ id: p.id, name: p.name })),
            theme: themeName,
            activeThemes: activeThemes,
            checked: checked,
            mismatched: mismatched,
            examples: examples,
            coverage: { colored: colored, bound: bound },
            perPage: perPage,
          })
      );
    }

    // ---------------------------------------------------------------
    // Main flow
    // ---------------------------------------------------------------
    if (["full", "init", "append", "count", "verify-theme"].indexOf(mode) === -1) {
      throw new Error("unknown mode " + mode);
    }

    // Append and count work on the Enterprise app page only and never touch
    // the Design System page.
    if (mode === "count") {
      await runCountMode();
      return;
    }
    if (mode === "append") {
      await runAppendMode();
      return;
    }
    // Read-only: checks the colours of the shapes against a token theme.
    if (mode === "verify-theme") {
      await runVerifyThemeMode();
      return;
    }

    // a. Design System page: rename the first page, or create one.
    const dsPage = await openDesignSystemPage();
    collecting = THEMED;
    await buildDesignSystem();

    // Init: components plus an empty map page. No screens.
    if (mode === "init") {
      const enterprise = penpot.createPage();
      enterprise.name = ENTERPRISE_PAGE_NAME;
      await penpot.openPage(enterprise);
      writeMapTexts(enterprise, config.layoutCapacity);
      await bindAllPages();
      console.log(
        "[large-design] DONE " +
          JSON.stringify({
            pages: [
              { id: dsPage.id, name: "Design System" },
              { id: enterprise.id, name: ENTERPRISE_PAGE_NAME },
            ],
            screens: 0,
            components: componentCount,
            themes: themingOn ? THEME_NAMES : undefined,
            bindings: bindingsApplied,
          })
      );
      return;
    }

    const pages = [{ id: dsPage.id, name: "Design System" }];
    let screens = 0;
    let firstScreenPage = null;
    let enterprisePage = null;

    // b. Enterprise app map (optional single page with mixed kinds).
    if (config.singlePageScreens > 0) {
      const enterprise = penpot.createPage();
      enterprise.name = "Enterprise app";
      await penpot.openPage(enterprise);
      enterprisePage = enterprise;
      pages.push({ id: enterprise.id, name: "Enterprise app" });
      const enterpriseCount = await buildEnterpriseApp(config.singlePageScreens);
      screens += enterpriseCount;
      console.log("[large-design] page done Enterprise app " + enterpriseCount);
    }

    // c. Screen pages.

    for (let p = 0; p < config.screenPages; p += 1) {
      const kind = SCREEN_KINDS[p % SCREEN_KINDS.length];
      const name = "Screens — " + kind + (p >= SCREEN_KINDS.length ? " " + (Math.floor(p / SCREEN_KINDS.length) + 1) : "");

      const page = penpot.createPage();
      page.name = name;
      await penpot.openPage(page);
      if (!firstScreenPage) firstScreenPage = page;

      let count = 0;
      for (let s = 0; s < config.screensPerPage; s += 1) {
        const screen = createScreen(kind, s);
        const compose = () => COMPOSERS[kind](screen);
        if (OLD_KINDS.includes(kind)) compose();
        else withStream(extraRandom, compose);
        withStream(extraRandom, () => addPopup(screen, kind));
        count += 1;
        await noteScreenBuilt();
      }

      pages.push({ id: page.id, name: name });
      screens += count;
      console.log("[large-design] page done " + name + " " + count);
    }

    // d. End: open the Enterprise page, else the first screen page, and report.
    const landingPage = enterprisePage || firstScreenPage;
    await bindAllPages();
    if (landingPage) await penpot.openPage(landingPage);
    console.log(
      "[large-design] DONE " +
        JSON.stringify({
          pages: pages,
          screens: screens,
          components: componentCount,
          themes: themingOn ? THEME_NAMES : undefined,
          bindings: bindingsApplied,
        })
    );
  } catch (err) {
    console.log("[large-design] ERROR " + String((err && err.stack) || err));
  }
})();
