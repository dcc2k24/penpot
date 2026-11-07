/**
 * JavaScript of the API layer of the sandbox facade, evaluated after the core.
 *
 * It defines the `penpot` and `penpotMgmt` globals, the shape proxies, and the library, font and utility objects.
 * Writes are queued through the core. Reads go through the core's page working copy, so a script sees its own
 * queued writes before the flush. Members of the Plugin API that have no backend equivalent are listed in
 * NOT_AVAILABLE in the source and throw when used.
 *
 * The font list is a subset of the built-in catalogue; see FontCatalog.ts and data/fonts.json.
 */
export const API_SOURCE: string = String.raw`
(function (global) {
  "use strict";

  // Coordinates. The bridge (frontend/src/app/plugins/shape.cljs) reads x and y from the absolute points rect, and
  // its setters use update-position with absolute true. So the Plugin API x and y are absolute page coordinates, the
  // same values the operations take. parentX, parentY, boardX and boardY are the relative values.
  //
  // Stacking. The children of a parent keep the backend order, where the last entry is the front-most shape. The
  // bridge appends at the end for bringToFront (vertical-order-selected, :top), and the children getter returns that
  // order. The facade follows the same order for appendChild, bringToFront and children.

  const core = global.__core;
  const ROOT_ID = "00000000-0000-0000-0000-000000000000";
  const HANDLE_PREFIX = "$tmp:";
  const REF = Symbol("shape reference");
  const DEFAULT_NAMESPACE = "mcp";
  const BOOL_TYPES = ["union", "difference", "intersection", "exclude"];
  const FILL_BLACK = [{ fillColor: "#000000", fillOpacity: 1 }];

  // members of the Plugin API that have no backend equivalent. The key is the name the error shows, and the value is
  // the alternative the error names.
  const NOT_AVAILABLE = {
    selection: "pass explicit shape ids",
    viewport: "there is no canvas in backend mode; use export_shape for a visual check",
    on: "use the typed tools",
    off: "use the typed tools",
    openPage: "pass pageId",
    openViewer: "pass pageId",
    currentUser: "use the whoami tool",
    activeUsers: "presence of open tabs is not tracked",
    localStorage: "use the storage object",
    createImage: "upload the image with uploadMediaUrl or uploadMediaData, then give it to a fill as fillImage",
    createShapeFromSvgWithImages: "embedded images are not uploaded; use createShapeFromSvg",
    generateMarkup: "code generation is not available in backend mode; use shape.export",
    generateStyle: "code generation is not available in backend mode",
    generateFontFaces: "font faces are not generated in backend mode",
    addListener: "use the typed tools",
    removeListener: "use the typed tools",
    createVariantFromComponents: "variant ops are not in the facade yet",
    "ui.open": "use the typed tools",
    "ui.resize": "use the typed tools",
    "ui.sendMessage": "use the typed tools",
    "ui.onMessage": "use the typed tools",
    "library.tokensSource": "the backend does not report the token source; assign it to set it",
    "penpotMgmt.workspace": "the workspace is a browser tab; pass fileId",
    "penpotMgmt.listDeletedProjects": "the backend has no command that lists deleted projects",
    "penpotMgmt.on": "use the typed tools",
    "penpotMgmt.off": "use the typed tools",
    "page.rulerGuides": "guides are not read in backend mode; add them with addRulerGuide",
    "page.flows": "flows are not read in backend mode; add them with createFlow",
    "shape.rulerGuides": "guides are not read in backend mode; add them with addRulerGuide",
    "shape.switchVariant": "variant ops are not in the facade yet",
    "shape.combineAsVariants": "variant ops are not in the facade yet",
    "shape.isVariantHead": "variant ops are not in the facade yet",
    "shape.isVariantContainer": "variant ops are not in the facade yet",
    "shape.waitForLayoutUpdate": "use penpot.waitForLayoutUpdate",
    textBounds: "the rendered text box is not in the backend record; use shape.bounds for the box of the shape"
  };

  // attributes the Plugin API reads as unsupported, with the alternative each error names.
  const UNSUPPORTED_ALTERNATIVES = {
    row: "use shape.layoutCell",
    rowSpan: "use shape.layoutCell",
    column: "use shape.layoutCell",
    columnSpan: "use shape.layoutCell",
    areaName: "use shape.layoutCell",
    position: "use shape.layoutCell",
    verticalMargin: "use shape.layoutChild",
    horizontalMargin: "use shape.layoutChild",
    keepAspectRatio: "the backend record does not expose it"
  };

  // flex options of addFlexLayout, with the backend attribute each one sets. The options go on the layout op itself,
  // because the backend schema reads them at the top level of the op.
  const LAYOUT_ATTRIBUTES = {
    dir: "layoutFlexDir",
    wrap: "layoutWrapType",
    alignItems: "layoutAlignItems",
    alignContent: "layoutAlignContent",
    justifyContent: "layoutJustifyContent",
    paddingType: "layoutPaddingType",
    horizontalSizing: "layoutItemHSizing",
    verticalSizing: "layoutItemVSizing"
  };

  // padding options and the p1 to p4 sides each one sets. Later entries win over earlier ones.
  const PADDING_SIDES = {
    verticalPadding: ["p1", "p3"],
    horizontalPadding: ["p2", "p4"],
    topPadding: ["p1"],
    rightPadding: ["p2"],
    bottomPadding: ["p3"],
    leftPadding: ["p4"]
  };

  // the Plugin API groups that set two padding sides at once.
  const PADDING_GROUPS = {
    verticalPadding: ["topPadding", "bottomPadding"],
    horizontalPadding: ["leftPadding", "rightPadding"]
  };

  // fields of the flex and grid layout objects, under the Plugin API names.
  const FLEX_FIELDS = [
    "dir", "wrap", "rowGap", "columnGap", "verticalPadding", "horizontalPadding", "topPadding", "rightPadding",
    "bottomPadding", "leftPadding", "alignItems", "alignContent", "justifyContent", "horizontalSizing", "verticalSizing"
  ];
  const GRID_FIELDS = [
    "dir", "rowGap", "columnGap", "verticalPadding", "horizontalPadding", "topPadding", "rightPadding",
    "bottomPadding", "leftPadding", "alignItems", "alignContent", "justifyItems", "justifyContent"
  ];

  // fields of the layout child object, and the backend attribute of each one that is stored as it is.
  const CHILD_FIELDS = [
    "absolute", "zIndex", "horizontalSizing", "verticalSizing", "alignSelf", "marginType", "horizontalMargin",
    "verticalMargin", "topMargin", "rightMargin", "bottomMargin", "leftMargin", "maxWidth", "minWidth", "maxHeight",
    "minHeight"
  ];
  const CHILD_ATTRIBUTES = {
    zIndex: "layoutItemZIndex",
    horizontalSizing: "layoutItemHSizing",
    verticalSizing: "layoutItemVSizing",
    alignSelf: "layoutItemAlignSelf",
    marginType: "layoutItemMarginType",
    maxWidth: "layoutItemMaxW",
    minWidth: "layoutItemMinW",
    maxHeight: "layoutItemMaxH",
    minHeight: "layoutItemMinH"
  };

  // fields of the layout cell object.
  const CELL_FIELDS = ["row", "column", "rowSpan", "columnSpan", "areaName", "position"];

  // triggers of an interaction, which are also its event types.
  const TRIGGERS = ["click", "mouse-enter", "mouse-leave", "after-delay"];

  // action types of the Plugin API, with the backend action type of each one.
  const ACTION_TYPES = {
    "navigate-to": "navigate",
    "open-overlay": "open-overlay",
    "toggle-overlay": "toggle-overlay",
    "close-overlay": "close-overlay",
    "previous-screen": "prev-screen",
    "open-url": "open-url"
  };

  // alignment directions of the Plugin API, with the backend axis of each one.
  const ALIGN_AXES = {
    horizontal: { left: "hleft", center: "hcenter", right: "hright" },
    vertical: { top: "vtop", center: "vcenter", bottom: "vbottom" }
  };

  // the alphabet of base64 text.
  const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  // font weight and style of the variants of the static font list.
  const FONT_VARIANTS = {
    regular: { name: "Regular", fontWeight: "400", fontStyle: "normal" },
    italic: { name: "Italic", fontWeight: "400", fontStyle: "italic" },
    "700": { name: "Bold", fontWeight: "700", fontStyle: "normal" }
  };

  // state of one script. The runner wrapper at the end clears it before each script.
  let libraryCache = new Map();
  let createdPages = [];
  const COMPONENT_HANDLES = new WeakSet();

  // helpers: errors and argument checks

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function isHandle(id) {
    return typeof id === "string" && id.indexOf(HANDLE_PREFIX) === 0;
  }

  function unavailable(key) {
    const reason = hasOwn(NOT_AVAILABLE, key) ? NOT_AVAILABLE[key] : "use the typed tools";
    return new Error(key + " is not available in backend mode; " + reason);
  }

  function notAvailableFn(key) {
    return function () {
      throw unavailable(key);
    };
  }

  function notAvailableGetter(key) {
    return function () {
      throw unavailable(key);
    };
  }

  function defineNotAvailable(target, key) {
    Object.defineProperty(target, key, { get: notAvailableGetter(key), enumerable: true, configurable: true });
  }

  function requireString(value, label) {
    if (typeof value !== "string") {
      throw new TypeError(label + " must be a string");
    }
    return value;
  }

  function requireNumber(value, label) {
    if (typeof value !== "number" || !isFinite(value)) {
      throw new TypeError(label + " must be a finite number");
    }
    return value;
  }

  function requireIndex(value, label) {
    if (typeof value !== "number" || !isFinite(value) || value < 0 || Math.floor(value) !== value) {
      throw new TypeError(label + " must be a whole number of 0 or more");
    }
    return value;
  }

  function numberOr(value, fallback) {
    return typeof value === "number" && isFinite(value) ? value : fallback;
  }

  function nameOption(options, fallback) {
    if (options && typeof options.name === "string" && options.name.length > 0) {
      return options.name;
    }
    return fallback;
  }

  // helpers: the file, its pages and the page model

  function outline() {
    return core.file();
  }

  function pageEntries() {
    const pages = outline().pages;
    return (Array.isArray(pages) ? pages : []).concat(createdPages);
  }

  // the page of the script when the file still has it, otherwise the first page of the file.
  function currentPageEntry() {
    const entries = pageEntries();
    const wanted = core.pageId();
    for (const entry of entries) {
      if (entry.id === wanted) {
        return entry;
      }
    }
    return entries.length > 0 ? entries[0] : null;
  }

  function currentPageId() {
    const entry = currentPageEntry();
    if (!entry) {
      throw new Error("the file has no page");
    }
    return entry.id;
  }

  function modelOf(pageId) {
    return core.page(undefined, pageId);
  }

  // the record of a shape, or undefined when the page does not hold it.
  function recordOf(ref) {
    if (typeof ref.pageId !== "string") {
      return undefined;
    }
    return modelOf(ref.pageId).get(ref.id);
  }

  function requireRecord(ref) {
    const record = recordOf(ref);
    if (!record) {
      throw new Error("shape " + core.resolve(ref.id) + " was not found on the page");
    }
    return record;
  }

  function updateProps(ref, props) {
    core.enqueue({ op: "update_shape", pageId: ref.pageId, id: ref.id, props: props });
  }

  // the props of one attribute update. A dotted attribute such as layoutItemMargin.m1 is merged into the stored
  // object, because the backend merges update props one level deep and would drop the sibling keys otherwise.
  function propsFor(ref, attr, value) {
    const parts = attr.split(".");
    const props = {};
    if (parts.length === 1) {
      props[attr] = value;
      return props;
    }
    const record = recordOf(ref);
    const stored = record && record[parts[0]] && typeof record[parts[0]] === "object" ? record[parts[0]] : {};
    const merged = Object.assign({}, stored);
    merged[parts[1]] = value;
    props[parts[0]] = merged;
    return props;
  }

  function readPath(object, path) {
    let value = object;
    for (const part of path.split(".")) {
      if (value === null || value === undefined) {
        return undefined;
      }
      value = value[part];
    }
    return value;
  }

  // helpers: shape references and proxies

  // the reference held by a shape proxy, or null for any other value.
  function refOf(value) {
    if (value === null || typeof value !== "object") {
      return null;
    }
    const ref = value[REF];
    return ref === undefined ? null : ref;
  }

  function requireShape(value, label) {
    const ref = refOf(value);
    if (!ref) {
      throw new TypeError(label + " must be a shape");
    }
    return ref;
  }

  function shapeRefs(shapes, label) {
    if (!Array.isArray(shapes)) {
      throw new TypeError(label + " must be an array of shapes");
    }
    return shapes.map(function (shape) {
      return requireShape(shape, label);
    });
  }

  // a proxy for a shape. A handle created in this call is always accepted, because its record may not be loaded yet.
  function makeShape(pageId, id) {
    const ref = { pageId: pageId, id: id };
    return new Proxy({}, {
      get: function (target, key) {
        return readMember(ref, key);
      },
      set: function (target, key, value) {
        writeMember(ref, key, value);
        return true;
      },
      deleteProperty: function () {
        throw new TypeError("shape properties cannot be deleted");
      }
    });
  }

  // a proxy when the page holds the id, or null when it does not.
  function shapeOrNull(pageId, id) {
    if (id === undefined || id === null) {
      return null;
    }
    const resolved = core.resolve(id);
    if (!isHandle(resolved) && !modelOf(pageId).has(resolved)) {
      return null;
    }
    return makeShape(pageId, id);
  }

  function childShapes(ref, record) {
    const ids = Array.isArray(record.shapes) ? record.shapes : [];
    const out = [];
    for (const id of ids) {
      const child = shapeOrNull(ref.pageId, id);
      if (child) {
        out.push(child);
      }
    }
    return out;
  }

  function bindMethod(ref, name) {
    const method = SHAPE_METHODS[name];
    return function () {
      return method.apply(null, [ref].concat(Array.prototype.slice.call(arguments)));
    };
  }

  function readMember(ref, key) {
    if (key === REF) {
      return ref;
    }
    if (typeof key !== "string") {
      return undefined;
    }
    if (key === "toJSON") {
      return function () {
        return shapeJSON(ref);
      };
    }
    if (key === "toString" || key === "valueOf") {
      return function () {
        return "[shape " + core.resolve(ref.id) + "]";
      };
    }
    if (hasOwn(SHAPE_METHODS, key)) {
      return bindMethod(ref, key);
    }
    if (hasOwn(NOT_AVAILABLE, "shape." + key)) {
      throw unavailable("shape." + key);
    }
    if (hasOwn(PROP.properties, key)) {
      return readProperty(ref, key, PROP.properties[key]);
    }
    // a promise check and the other probes of the engine read undefined; a member the facade lacks fails by name
    if (key === "then") {
      return undefined;
    }
    throw new TypeError(key + " is not a shape member in backend mode; check the name against the Plugin API");
  }

  function writeMember(ref, key, value) {
    if (typeof key !== "string") {
      throw new TypeError("shape members are named by strings");
    }
    if (hasOwn(SHAPE_METHODS, key) || hasOwn(NOT_AVAILABLE, "shape." + key)) {
      throw new TypeError(key + " is a method and cannot be assigned");
    }
    if (!hasOwn(PROP.properties, key)) {
      throw new TypeError(key + " is not a shape property in backend mode");
    }
    writeProperty(ref, key, PROP.properties[key], value);
  }

  // helpers: text content

  function textOf(node) {
    if (typeof node.text === "string") {
      return node.text;
    }
    const children = Array.isArray(node.children) ? node.children : [];
    return children.map(textOf).join("");
  }

  function paragraphsOf(node, out) {
    if (node.type === "paragraph") {
      out.push(textOf(node));
      return out;
    }
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) {
      paragraphsOf(child, out);
    }
    return out;
  }

  // the plain text of a content tree, with a line break between paragraphs.
  function charactersOf(content) {
    if (!content) {
      return "";
    }
    return paragraphsOf(content, []).join("\n");
  }

  // the chain from the root of the content tree down to the first text leaf, or null when there is none.
  function firstLeafChain(node, chain) {
    const here = chain.concat([node]);
    if (typeof node.text === "string") {
      return here;
    }
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) {
      const found = firstLeafChain(child, here);
      if (found) {
        return found;
      }
    }
    return null;
  }

  // a typography value of the first text leaf. A value that the leaf does not set comes from the nearest ancestor
  // that sets it, so paragraph values and root values are found too.
  function contentAttr(record, attr) {
    const chain = record.content ? firstLeafChain(record.content, []) : null;
    if (!chain) {
      return undefined;
    }
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      if (chain[i][attr] !== undefined) {
        return chain[i][attr];
      }
    }
    return undefined;
  }

  // helpers: derived values

  function rectOf(record) {
    const box = record.selrect || record;
    return {
      x: numberOr(box.x, 0),
      y: numberOr(box.y, 0),
      width: numberOr(box.width, 0),
      height: numberOr(box.height, 0)
    };
  }

  // the offset of a record from the absolute x or y of one of its owners (parent or board).
  function relativeTo(ref, record, ownerId, axis) {
    const owner = modelOf(ref.pageId).get(ownerId);
    const base = owner ? numberOr(owner[axis], 0) : 0;
    return numberOr(record[axis], 0) - base;
  }

  function indexInParent(ref, record) {
    const parent = modelOf(ref.pageId).get(record.parentId);
    if (!parent || !Array.isArray(parent.shapes)) {
      return 0;
    }
    return parent.shapes.indexOf(record.id);
  }

  // SVG path data of the path commands the bridge writes (move-to, line-to, curve-to, close-path).
  function pathData(content) {
    if (!Array.isArray(content)) {
      return "";
    }
    const parts = [];
    for (const segment of content) {
      const p = segment.params || {};
      if (segment.command === "move-to") {
        parts.push("M " + p.x + " " + p.y);
      } else if (segment.command === "line-to") {
        parts.push("L " + p.x + " " + p.y);
      } else if (segment.command === "curve-to") {
        parts.push("C " + p.c1x + " " + p.c1y + " " + p.c2x + " " + p.c2y + " " + p.x + " " + p.y);
      } else if (segment.command === "close-path") {
        parts.push("Z");
      }
    }
    return parts.join(" ");
  }

  function readDerived(ref, record, name) {
    if (!record) {
      return undefined;
    }
    switch (name) {
      case "parent":
        return shapeOrNull(ref.pageId, record.parentId);
      case "parentIndex":
        return indexInParent(ref, record);
      case "children":
        return childShapes(ref, record);
      case "tokens":
        return record.appliedTokens || {};
      case "bounds":
        return rectOf(record);
      case "center": {
        const box = rectOf(record);
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }
      case "parentX":
        return relativeTo(ref, record, record.parentId, "x");
      case "parentY":
        return relativeTo(ref, record, record.parentId, "y");
      case "boardX":
        return relativeTo(ref, record, record.frameId, "x");
      case "boardY":
        return relativeTo(ref, record, record.frameId, "y");
      case "d":
        return pathData(record.content);
      case "commands":
        return record.content;
      case "mtype":
        return record.metadata ? record.metadata.mtype : undefined;
      case "textBounds":
        // the stored position data is not a box, so the facade does not return it as one
        throw unavailable("textBounds");
      case "flex":
        return record.layout === "flex" ? layoutView(ref, "flex") : null;
      case "grid":
        return record.layout === "grid" ? layoutView(ref, "grid") : null;
      case "layoutChild":
        return childLayoutOf(ref, record);
      case "layoutCell":
        return cellLayoutOf(ref, record);
      case "interactions":
        return interactionsOf(ref, record);
      default:
        return undefined;
    }
  }

  function readContent(record, name, entry) {
    if (name === "characters") {
      return charactersOf(record.content);
    }
    return contentAttr(record, entry.attr);
  }

  function unsupportedError(name) {
    const alternative = hasOwn(UNSUPPORTED_ALTERNATIVES, name) ? UNSUPPORTED_ALTERNATIVES[name] : "no backend equivalent";
    return new Error(name + " is not available in backend mode; " + alternative);
  }

  function readProperty(ref, name, entry) {
    if (entry.kind === "unsupported") {
      throw unsupportedError(name);
    }
    if (name === "id") {
      return core.resolve(ref.id);
    }
    const record = recordOf(ref);
    if (entry.kind === "derived") {
      return readDerived(ref, record, name);
    }
    if (entry.kind === "content") {
      return record ? readContent(record, name, entry) : undefined;
    }
    if (!record) {
      return undefined;
    }
    if (name === "type") {
      return PROP.types[record.type] || record.type;
    }
    if (name === "fills" && record.type === "text") {
      return contentAttr(record, "fills");
    }
    const value = readPath(record, entry.attr);
    if (entry.invert) {
      return value === undefined ? undefined : !value;
    }
    return value;
  }

  // helpers: writes

  function writeTextStyle(ref, attr, value) {
    const attrs = {};
    attrs[attr] = value;
    core.enqueue({ op: "set_text_style", pageId: ref.pageId, id: ref.id, attrs: attrs });
  }

  function writeContent(ref, name, entry, value) {
    const record = recordOf(ref);
    if (record && record.type !== "text") {
      throw new TypeError(name + " is only available on text shapes");
    }
    if (name === "characters") {
      core.enqueue({ op: "set_text", pageId: ref.pageId, id: ref.id, characters: requireString(value, "characters") });
      return;
    }
    writeTextStyle(ref, entry.attr, value);
  }

  // a path's content goes through set_path_content, which the compiler requires; the box of the path is refitted.
  function writePathContent(ref, value) {
    const record = recordOf(ref);
    if (record && record.type !== "path") {
      throw new TypeError("content is only available on path shapes");
    }
    core.enqueue({ op: "set_path_content", pageId: ref.pageId, id: ref.id, content: value });
  }

  function writeProperty(ref, name, entry, value) {
    if (entry.kind === "unsupported") {
      throw unsupportedError(name);
    }
    if (entry.access === "read" || entry.kind === "derived") {
      throw new TypeError(name + " is read-only in backend mode");
    }
    if (entry.kind === "content") {
      writeContent(ref, name, entry, value);
      return;
    }
    // the layout item attributes go through set_layout_child, which the compiler requires for them in props.
    if (entry.kind === "layout-child") {
      writeChildField(ref, name, value);
      return;
    }
    if (entry.kind === "path-content") {
      writePathContent(ref, value);
      return;
    }
    if (entry.kind === "geometry") {
      if (name === "flipX" || name === "flipY") {
        throw new TypeError(
          name +
            " is not supported in backend mode: no flip operation exists. " +
            "The typed operations have no transform or matrix op, so flipping needs a new operation; " +
            "recreate the shape with the wanted geometry instead."
        );
      }
      requireNumber(value, name);
      updateProps(ref, propsFor(ref, entry.attr, value));
      return;
    }
    if (name === "fills") {
      const record = recordOf(ref);
      if (record && record.type === "text") {
        writeTextStyle(ref, "fills", value);
        return;
      }
    }
    if (name === "borderRadius") {
      updateProps(ref, { r1: value, r2: value, r3: value, r4: value });
      return;
    }
    updateProps(ref, propsFor(ref, entry.attr, entry.invert ? !value : value));
  }

  // helpers: serialisation

  function shapeJSON(ref) {
    const record = recordOf(ref);
    if (!record) {
      return { id: core.resolve(ref.id), name: null, type: null, x: null, y: null, width: null, height: null, parentId: null, children: [] };
    }
    const shapes = Array.isArray(record.shapes) ? record.shapes : [];
    return {
      id: core.resolve(ref.id),
      name: record.name,
      type: PROP.types[record.type] || record.type,
      x: record.x,
      y: record.y,
      width: record.width,
      height: record.height,
      parentId: record.parentId,
      children: shapes.map(function (id) {
        return core.resolve(id);
      })
    };
  }

  // shape methods: geometry, structure and stacking

  function resizeShape(ref, width, height) {
    updateProps(ref, { width: requireNumber(width, "width"), height: requireNumber(height, "height") });
  }

  // the Plugin API turns the shape by the given angle, so the new rotation adds the angle to the current one.
  function rotateShape(ref, angle, center) {
    if (center !== undefined && center !== null) {
      throw new Error("rotate with a center is not available in backend mode; the shape turns around its own center");
    }
    const record = requireRecord(ref);
    updateProps(ref, { rotation: numberOr(record.rotation, 0) + requireNumber(angle, "angle") });
  }

  function cloneShape(ref) {
    const cloneId = core.handle("clone");
    core.enqueue({ op: "clone_shape", pageId: ref.pageId, id: ref.id, newId: cloneId });
    return makeShape(ref.pageId, cloneId);
  }

  function removeShape(ref) {
    core.enqueue({ op: "delete_shapes", pageId: ref.pageId, ids: [ref.id] });
  }

  // an index of undefined appends the child at the end, which is the front of the parent.
  function moveInto(parentRef, child, index) {
    const childRef = requireShape(child, "child");
    const op = { op: "move_shapes", pageId: parentRef.pageId, ids: [childRef.id], parentId: parentRef.id };
    if (index !== undefined) {
      op.index = requireIndex(index, "index");
    }
    core.enqueue(op);
  }

  function setParentIndex(ref, index) {
    const record = requireRecord(ref);
    core.enqueue({
      op: "move_shapes",
      pageId: ref.pageId,
      ids: [ref.id],
      parentId: record.parentId,
      index: requireIndex(index, "index")
    });
  }

  // moves the shape inside its parent. The pick function gets the child ids and the index of the shape, and returns
  // the new full order, or null when nothing moves.
  function restackShape(ref, pick) {
    const record = requireRecord(ref);
    const parent = modelOf(ref.pageId).get(record.parentId);
    if (!parent || !Array.isArray(parent.shapes)) {
      return;
    }
    const ids = parent.shapes.slice();
    const at = ids.indexOf(record.id);
    if (at < 0) {
      return;
    }
    const next = pick(ids, at);
    if (next) {
      core.enqueue({ op: "reorder", pageId: ref.pageId, parentId: record.parentId, ids: next });
    }
  }

  function withMoved(ids, from, to) {
    const out = ids.slice();
    const moved = out.splice(from, 1)[0];
    out.splice(to, 0, moved);
    return out;
  }

  function withSwapped(ids, a, b) {
    const out = ids.slice();
    const first = out[a];
    out[a] = out[b];
    out[b] = first;
    return out;
  }

  function toFront(ids, at) {
    return withMoved(ids, at, ids.length - 1);
  }

  function toBack(ids, at) {
    return withMoved(ids, at, 0);
  }

  function oneForward(ids, at) {
    return at < ids.length - 1 ? withSwapped(ids, at, at + 1) : null;
  }

  function oneBackward(ids, at) {
    return at > 0 ? withSwapped(ids, at, at - 1) : null;
  }

  // shape methods: layout, masks and components

  // the Plugin API option names are mapped to layout attributes, and the padding sides are gathered into one object.
  function layoutAttributes(options) {
    const source = options === undefined || options === null ? {} : options;
    const out = {};
    const gap = {};
    const padding = { p1: 0, p2: 0, p3: 0, p4: 0 };
    let hasPadding = false;
    for (const key of Object.keys(source)) {
      if (hasOwn(LAYOUT_ATTRIBUTES, key)) {
        out[LAYOUT_ATTRIBUTES[key]] = source[key];
      } else if (key === "rowGap" || key === "columnGap") {
        gap[key] = requireNumber(source[key], key);
      } else if (hasOwn(PADDING_SIDES, key)) {
        hasPadding = true;
      } else if (key.indexOf("layout") === 0) {
        out[key] = source[key];
      } else {
        throw new TypeError("unknown layout option " + key);
      }
    }
    for (const key of Object.keys(PADDING_SIDES)) {
      if (hasOwn(source, key)) {
        for (const side of PADDING_SIDES[key]) {
          padding[side] = requireNumber(source[key], key);
        }
      }
    }
    if (Object.keys(gap).length > 0) {
      out.layoutGap = gap;
    }
    if (hasPadding) {
      out.layoutPadding = padding;
    }
    return out;
  }

  function layoutOp(ref, opName, options) {
    const op = { op: opName, pageId: ref.pageId, id: ref.id };
    const attrs = layoutAttributes(options);
    for (const key of Object.keys(attrs)) {
      op[key] = attrs[key];
    }
    core.enqueue(op);
  }

  // a copy of an object without its undefined members, so that JSON leaves them out.
  function withoutUndefined(object) {
    const out = {};
    for (const key of Object.keys(object)) {
      if (object[key] !== undefined) {
        out[key] = object[key];
      }
    }
    return out;
  }

  // the padding of a layout op, or undefined when no side is given. A side that is not given counts as zero.
  function paddingOf(o) {
    if (o.topPadding === undefined && o.rightPadding === undefined && o.bottomPadding === undefined &&
        o.leftPadding === undefined) {
      return undefined;
    }
    return {
      p1: numberOr(o.topPadding, 0),
      p2: numberOr(o.rightPadding, 0),
      p3: numberOr(o.bottomPadding, 0),
      p4: numberOr(o.leftPadding, 0)
    };
  }

  // the gap of a layout op, or undefined when neither gap is given.
  function gapOf(o) {
    if (o.rowGap === undefined && o.columnGap === undefined) {
      return undefined;
    }
    return withoutUndefined({ rowGap: o.rowGap, columnGap: o.columnGap });
  }

  // the flex op of a board. It carries the whole layout, because the compiler resets the attributes it does not get.
  function flexOp(ref, o) {
    return withoutUndefined({
      op: "set_flex_layout",
      pageId: ref.pageId,
      id: ref.id,
      layoutFlexDir: o.dir,
      layoutWrapType: o.wrap,
      layoutAlignItems: o.alignItems,
      layoutAlignContent: o.alignContent,
      layoutJustifyContent: o.justifyContent,
      layoutGap: gapOf(o),
      layoutPadding: paddingOf(o),
      layoutItemHSizing: o.horizontalSizing,
      layoutItemVSizing: o.verticalSizing
    });
  }

  // the grid op of a board. Like flexOp, it carries the whole layout.
  function gridOp(ref, o) {
    return withoutUndefined({
      op: "set_grid_layout",
      pageId: ref.pageId,
      id: ref.id,
      layoutGridDir: o.dir,
      layoutGridRows: o.rows,
      layoutGridColumns: o.columns,
      layoutGap: gapOf(o),
      layoutPadding: paddingOf(o),
      layoutAlignItems: o.alignItems,
      layoutJustifyItems: o.justifyItems,
      layoutAlignContent: o.alignContent,
      layoutJustifyContent: o.justifyContent
    });
  }

  // the flex options of a board record, under the Plugin API names.
  function flexOptionsOf(record) {
    const gap = record.layoutGap || {};
    const pad = record.layoutPadding || {};
    return {
      dir: record.layoutFlexDir,
      wrap: record.layoutWrapType,
      alignItems: record.layoutAlignItems,
      alignContent: record.layoutAlignContent,
      justifyContent: record.layoutJustifyContent,
      rowGap: numberOr(gap.rowGap, 0),
      columnGap: numberOr(gap.columnGap, 0),
      topPadding: numberOr(pad.p1, 0),
      rightPadding: numberOr(pad.p2, 0),
      bottomPadding: numberOr(pad.p3, 0),
      leftPadding: numberOr(pad.p4, 0),
      horizontalSizing: record.layoutItemHSizing,
      verticalSizing: record.layoutItemVSizing
    };
  }

  // the grid options of a board record, under the Plugin API names.
  function gridOptionsOf(record) {
    const gap = record.layoutGap || {};
    const pad = record.layoutPadding || {};
    return {
      dir: record.layoutGridDir,
      rows: Array.isArray(record.layoutGridRows) ? record.layoutGridRows.slice() : [],
      columns: Array.isArray(record.layoutGridColumns) ? record.layoutGridColumns.slice() : [],
      alignItems: record.layoutAlignItems,
      alignContent: record.layoutAlignContent,
      justifyItems: record.layoutJustifyItems,
      justifyContent: record.layoutJustifyContent,
      rowGap: numberOr(gap.rowGap, 0),
      columnGap: numberOr(gap.columnGap, 0),
      topPadding: numberOr(pad.p1, 0),
      rightPadding: numberOr(pad.p2, 0),
      bottomPadding: numberOr(pad.p3, 0),
      leftPadding: numberOr(pad.p4, 0)
    };
  }

  function layoutOptionsOf(record, kind) {
    return kind === "grid" ? gridOptionsOf(record) : flexOptionsOf(record);
  }

  // the value of one layout field. verticalPadding reads the top side and horizontalPadding reads the left side.
  function readLayoutField(options, name) {
    if (name === "verticalPadding") {
      return options.topPadding;
    }
    if (name === "horizontalPadding") {
      return options.leftPadding;
    }
    return options[name];
  }

  // the changes that one layout field makes to the layout options, keyed by the option names.
  function layoutChanges(name, value) {
    const out = {};
    if (hasOwn(PADDING_GROUPS, name)) {
      for (const side of PADDING_GROUPS[name]) {
        out[side] = value;
      }
    } else {
      out[name] = value;
    }
    return out;
  }

  // writes one field of a flex or grid layout, by queueing the whole layout with the field changed.
  function writeLayoutField(ref, kind, name, value) {
    const record = requireRecord(ref);
    if (/Gap|Padding/.test(name)) {
      requireNumber(value, name);
    }
    const options = layoutOptionsOf(record, kind);
    Object.assign(options, layoutChanges(name, value));
    core.enqueue(kind === "grid" ? gridOp(ref, options) : flexOp(ref, options));
  }

  // the options of addGridLayout. An option that is not given keeps the default of the compiler.
  function gridLayoutOp(ref, options) {
    const source = options === undefined || options === null ? {} : options;
    const o = {};
    for (const name of Object.keys(source)) {
      if (name === "rows" || name === "columns") {
        o[name] = trackListOf(source[name], name);
      } else if (GRID_FIELDS.indexOf(name) >= 0 || hasOwn(PADDING_GROUPS, name)) {
        if (/Gap|Padding/.test(name)) {
          requireNumber(source[name], name);
        }
        Object.assign(o, layoutChanges(name, source[name]));
      } else {
        throw new TypeError("unknown grid layout option " + name);
      }
    }
    core.enqueue(gridOp(ref, o));
  }

  // a grid track, as the backend stores it: a type and a value, which is null when the track has none.
  function trackOf(type, value) {
    return {
      type: requireString(type, "type"),
      value: value === undefined || value === null ? null : requireNumber(value, "value")
    };
  }

  // the tracks given by a script, checked one by one.
  function trackListOf(list, label) {
    if (!Array.isArray(list)) {
      throw new TypeError(label + " must be an array of tracks");
    }
    return list.map(function (track) {
      return trackOf(track && track.type, track && track.value);
    });
  }

  // adds a row or column to a grid, or removes one, and queues the whole grid layout.
  function editTrack(ref, axis, action, index, track) {
    const options = gridOptionsOf(requireRecord(ref));
    const tracks = options[axis];
    if (action === "add") {
      const at = index === undefined ? tracks.length : requireIndex(index, "index");
      tracks.splice(at, 0, track);
    } else {
      const at = requireIndex(index, "index");
      if (at >= tracks.length) {
        throw new RangeError("track index " + at + " is out of range");
      }
      tracks.splice(at, 1);
    }
    options[axis] = tracks;
    core.enqueue(gridOp(ref, options));
  }

  // the object of a flex or grid layout. Each field reads the board record, and each assignment queues the layout.
  function layoutView(ref, kind) {
    const view = {};
    const fields = kind === "grid" ? GRID_FIELDS : FLEX_FIELDS;
    for (const name of fields) {
      Object.defineProperty(view, name, {
        enumerable: true,
        configurable: true,
        get: function () {
          const record = recordOf(ref);
          return record ? readLayoutField(layoutOptionsOf(record, kind), name) : undefined;
        },
        set: function (value) {
          writeLayoutField(ref, kind, name, value);
        }
      });
    }
    view.appendChild = function (child) {
      moveInto(ref, child, undefined);
    };
    view.remove = function () {
      core.enqueue({ op: "remove_layout", pageId: ref.pageId, id: ref.id });
    };
    if (kind === "grid") {
      for (const axis of ["rows", "columns"]) {
        Object.defineProperty(view, axis, {
          enumerable: true,
          configurable: true,
          get: function () {
            const record = recordOf(ref);
            return record ? gridOptionsOf(record)[axis] : [];
          }
        });
      }
      view.addRow = function (type, value) {
        editTrack(ref, "rows", "add", undefined, trackOf(type, value));
      };
      view.addRowAtIndex = function (index, type, value) {
        editTrack(ref, "rows", "add", index, trackOf(type, value));
      };
      view.removeRow = function (index) {
        editTrack(ref, "rows", "remove", index, undefined);
      };
      view.addColumn = function (type, value) {
        editTrack(ref, "columns", "add", undefined, trackOf(type, value));
      };
      view.addColumnAtIndex = function (index, type, value) {
        editTrack(ref, "columns", "add", index, trackOf(type, value));
      };
      view.removeColumn = function (index) {
        editTrack(ref, "columns", "remove", index, undefined);
      };
    }
    return view;
  }

  // the layout child options of a shape record, under the Plugin API names.
  function childOptionsOf(record) {
    const margin = record.layoutItemMargin || {};
    return {
      absolute: record.layoutItemAbsolute === true,
      zIndex: numberOr(record.layoutItemZIndex, 0),
      horizontalSizing: record.layoutItemHSizing,
      verticalSizing: record.layoutItemVSizing,
      alignSelf: record.layoutItemAlignSelf,
      marginType: record.layoutItemMarginType,
      horizontalMargin: numberOr(margin.m2, 0),
      verticalMargin: numberOr(margin.m1, 0),
      topMargin: numberOr(margin.m1, 0),
      rightMargin: numberOr(margin.m2, 0),
      bottomMargin: numberOr(margin.m3, 0),
      leftMargin: numberOr(margin.m4, 0),
      maxWidth: record.layoutItemMaxW,
      minWidth: record.layoutItemMinW,
      maxHeight: record.layoutItemMaxH,
      minHeight: record.layoutItemMinH
    };
  }

  // writes one field of a layout child, by queueing set_layout_child with that field.
  function writeChildField(ref, name, value) {
    const record = requireRecord(ref);
    const op = { op: "set_layout_child", pageId: ref.pageId, id: ref.id };
    if (/Margin$/.test(name)) {
      requireNumber(value, name);
      const current = record.layoutItemMargin || {};
      const margin = {
        m1: numberOr(current.m1, 0),
        m2: numberOr(current.m2, 0),
        m3: numberOr(current.m3, 0),
        m4: numberOr(current.m4, 0)
      };
      if (name === "topMargin") {
        margin.m1 = value;
      } else if (name === "rightMargin") {
        margin.m2 = value;
      } else if (name === "bottomMargin") {
        margin.m3 = value;
      } else if (name === "leftMargin") {
        margin.m4 = value;
      } else if (name === "verticalMargin") {
        margin.m1 = value;
        margin.m3 = value;
      } else {
        margin.m2 = value;
        margin.m4 = value;
      }
      op.layoutItemMargin = margin;
    } else if (name === "absolute") {
      op.layoutItemAbsolute = value === true;
    } else {
      if (name === "zIndex" || /^(min|max)/.test(name)) {
        requireNumber(value, name);
      }
      op[CHILD_ATTRIBUTES[name]] = value;
    }
    core.enqueue(op);
  }

  // the layout child object of a shape. Each assignment queues set_layout_child.
  function childLayoutView(ref) {
    const view = {};
    for (const name of CHILD_FIELDS) {
      Object.defineProperty(view, name, {
        enumerable: true,
        configurable: true,
        get: function () {
          const record = recordOf(ref);
          return record ? childOptionsOf(record)[name] : undefined;
        },
        set: function (value) {
          writeChildField(ref, name, value);
        }
      });
    }
    return view;
  }

  // the parent record of a shape record, or undefined when the parent is not loaded.
  function parentRecordOf(ref, record) {
    return modelOf(ref.pageId).get(record.parentId);
  }

  // the grid cell that holds a child, or null when the child has none.
  function cellOf(parent, childId) {
    const cells = parent.layoutGridCells || {};
    for (const key of Object.keys(cells)) {
      const cell = cells[key];
      if (cell && Array.isArray(cell.shapes) && cell.shapes.indexOf(childId) >= 0) {
        return cell;
      }
    }
    return null;
  }

  // writes one field of a layout cell, by queueing set_grid_cell with the whole placement.
  function writeCellField(ref, name, value) {
    const record = requireRecord(ref);
    const parent = parentRecordOf(ref, record);
    if (!parent || parent.layout !== "grid") {
      throw new Error("layoutCell needs a parent with a grid layout");
    }
    if (name === "areaName" || name === "position") {
      throw new TypeError(name + " is read-only in backend mode");
    }
    if (typeof value !== "number" || !isFinite(value) || Math.floor(value) !== value || value < 1) {
      throw new TypeError(name + " must be a whole number of 1 or more");
    }
    const cell = cellOf(parent, ref.id) || {};
    const next = {
      row: numberOr(cell.row, 1),
      column: numberOr(cell.column, 1),
      rowSpan: numberOr(cell.rowSpan, 1),
      columnSpan: numberOr(cell.columnSpan, 1)
    };
    next[name] = value;
    core.enqueue({
      op: "set_grid_cell",
      pageId: ref.pageId,
      gridId: record.parentId,
      childId: ref.id,
      row: next.row,
      column: next.column,
      rowSpan: next.rowSpan,
      columnSpan: next.columnSpan
    });
  }

  // the layout cell object of a shape. Each assignment queues set_grid_cell.
  function cellLayoutView(ref) {
    const view = {};
    for (const name of CELL_FIELDS) {
      Object.defineProperty(view, name, {
        enumerable: true,
        configurable: true,
        get: function () {
          const record = recordOf(ref);
          const parent = record ? parentRecordOf(ref, record) : undefined;
          const cell = parent ? cellOf(parent, ref.id) : null;
          return cell ? cell[name] : undefined;
        },
        set: function (value) {
          writeCellField(ref, name, value);
        }
      });
    }
    return view;
  }

  // the layout child object of a shape, or null when its parent has no flex or grid layout.
  function childLayoutOf(ref, record) {
    const parent = parentRecordOf(ref, record);
    if (!parent || (parent.layout !== "flex" && parent.layout !== "grid")) {
      return null;
    }
    return childLayoutView(ref);
  }

  // the layout cell object of a shape, or null when its parent has no grid layout.
  function cellLayoutOf(ref, record) {
    const parent = parentRecordOf(ref, record);
    if (!parent || parent.layout !== "grid") {
      return null;
    }
    return cellLayoutView(ref);
  }

  function componentIdOf(component) {
    if (component && typeof component.id === "string" && component.id.length > 0) {
      return component.id;
    }
    throw new TypeError("component must be a component with an id");
  }

  function componentFlag(ref, test) {
    const record = recordOf(ref);
    return record ? test(record) : false;
  }

  function hasComponent(record) {
    return record.componentId !== undefined && record.componentId !== null;
  }

  // plugin data is stored under the bucket plugin/<namespace> for private data and shared/<namespace> for shared
  // data. The backend keys the bucket by the whole string, so the prefix is part of the namespace of the op.
  function setPluginDataOp(ref, prefix, namespace, key, value) {
    core.enqueue({
      op: "set_plugin_data",
      target: "shape",
      id: ref.id,
      pageId: ref.pageId,
      namespace: prefix + "/" + requireString(namespace, "namespace"),
      key: requireString(key, "key"),
      value: requireString(value, "value")
    });
  }

  function pluginDataOf(ref, prefix, namespace, key) {
    const record = recordOf(ref);
    const bucket = record && record.pluginData ? record.pluginData[prefix + "/" + namespace] : undefined;
    const value = bucket ? bucket[requireString(key, "key")] : undefined;
    return value === undefined ? "" : value;
  }

  // token types. A Plugin API type name maps to the internal name, as the DTCG names map in the backend
  // (common/types/token.cljc). The singular names are input aliases only.
  const TOKEN_TYPE_PLUGIN_NAMES = {
    "boolean": "boolean",
    "border-radius": "borderRadius",
    "color": "color",
    "dimensions": "dimension",
    "font-family": "fontFamilies",
    "font-size": "fontSizes",
    "font-weight": "fontWeights",
    "letter-spacing": "letterSpacing",
    "number": "number",
    "opacity": "opacity",
    "other": "other",
    "rotation": "rotation",
    "shadow": "shadow",
    "sizing": "sizing",
    "spacing": "spacing",
    "string": "string",
    "stroke-width": "borderWidth",
    "text-case": "textCase",
    "text-decoration": "textDecoration",
    "typography": "typography"
  };

  const TOKEN_TYPE_ALIASES = {
    fontWeight: "font-weight",
    fontSize: "font-size",
    fontFamily: "font-family",
    boxShadow: "shadow"
  };

  // the internal type of a Plugin or alias type name, or undefined when the name is not one.
  function internalTokenTypeOf(name) {
    if (hasOwn(TOKEN_TYPE_ALIASES, name)) {
      return TOKEN_TYPE_ALIASES[name];
    }
    const found = Object.keys(TOKEN_TYPE_PLUGIN_NAMES).find(function (internal) {
      return TOKEN_TYPE_PLUGIN_NAMES[internal] === name;
    });
    return found;
  }

  // the Plugin API name of an internal type. A type without a Plugin name keeps its internal name.
  function pluginTokenTypeOf(internal) {
    return hasOwn(TOKEN_TYPE_PLUGIN_NAMES, internal) ? TOKEN_TYPE_PLUGIN_NAMES[internal] : internal;
  }

  // token attributes. A Plugin attribute name maps to canonical names, as app.plugins.tokens does: the corner radii,
  // the paddings and the margins are renamed, the font family is renamed, and strokeWidth expands to the four sides.
  const TOKEN_ATTRIBUTE_ALIASES = {
    "border-radius-top-left": ["r1"],
    "border-radius-top-right": ["r2"],
    "border-radius-bottom-right": ["r3"],
    "border-radius-bottom-left": ["r4"],
    "padding-top": ["p1"],
    "padding-right": ["p2"],
    "padding-bottom": ["p3"],
    "padding-left": ["p4"],
    "margin-top": ["m1"],
    "margin-right": ["m2"],
    "margin-bottom": ["m3"],
    "margin-left": ["m4"],
    "font-families": ["font-family"],
    "stroke-width": ["stroke-width-top", "stroke-width-right", "stroke-width-bottom", "stroke-width-left"]
  };

  const RADIUS_ATTRIBUTES = ["r1", "r2", "r3", "r4"];
  const SIZING_ATTRIBUTES = ["width", "height", "layout-item-min-w", "layout-item-max-w", "layout-item-min-h", "layout-item-max-h"];
  const SPACING_ATTRIBUTES = ["row-gap", "column-gap", "p1", "p2", "p3", "p4", "m1", "m2", "m3", "m4"];
  const STROKE_WIDTH_ATTRIBUTES = ["stroke-width-top", "stroke-width-right", "stroke-width-bottom", "stroke-width-left"];

  // the attributes that a token type applies to. The "all" attribute name stands for this list of the token type,
  // as the Plugin frontend lists them (app.main.data.workspace.tokens.application). Every canonical name is in one.
  const TOKEN_TYPE_ATTRIBUTES = {
    "border-radius": RADIUS_ATTRIBUTES,
    "shadow": ["shadow"],
    "color": ["fill", "stroke-color"],
    "font-size": ["font-size"],
    "letter-spacing": ["letter-spacing"],
    "font-family": ["font-family"],
    "text-case": ["text-case"],
    "font-weight": ["font-weight"],
    "typography": ["typography"],
    "text-decoration": ["text-decoration"],
    "stroke-width": STROKE_WIDTH_ATTRIBUTES,
    "sizing": SIZING_ATTRIBUTES,
    "dimensions": SPACING_ATTRIBUTES.concat(SIZING_ATTRIBUTES, RADIUS_ATTRIBUTES, ["x", "y"], STROKE_WIDTH_ATTRIBUTES),
    "opacity": ["opacity"],
    "number": ["line-height", "rotation"],
    "rotation": ["rotation"],
    "spacing": SPACING_ATTRIBUTES
  };

  // true when the name is a canonical token attribute, which the backend takes as it is.
  function isCanonicalTokenAttribute(name) {
    return Object.keys(TOKEN_TYPE_ATTRIBUTES).some(function (type) {
      return TOKEN_TYPE_ATTRIBUTES[type].indexOf(name) >= 0;
    });
  }

  // the canonical names of one Plugin attribute name. "all" is every attribute of the token type. An unknown name is
  // refused with a TypeError that names it.
  function canonicalAttributesOf(name, tokenType) {
    const text = requireString(name, "attribute");
    const kebab = text.replace(/[A-Z]/g, function (letter) {
      return "-" + letter.toLowerCase();
    });
    if (kebab === "all") {
      if (!hasOwn(TOKEN_TYPE_ATTRIBUTES, tokenType)) {
        throw new TypeError("all has no attributes for the token type " + tokenType);
      }
      return TOKEN_TYPE_ATTRIBUTES[tokenType].slice();
    }
    if (hasOwn(TOKEN_ATTRIBUTE_ALIASES, kebab)) {
      return TOKEN_ATTRIBUTE_ALIASES[kebab].slice();
    }
    if (isCanonicalTokenAttribute(kebab)) {
      return [kebab];
    }
    throw new TypeError("unknown token attribute " + text);
  }

  // the canonical names of a list of Plugin attribute names, each name once, in order.
  function tokenAttributesOf(properties, tokenType) {
    const attributes = [];
    for (const name of properties) {
      for (const attribute of canonicalAttributesOf(name, tokenType)) {
        if (attributes.indexOf(attribute) < 0) {
          attributes.push(attribute);
        }
      }
    }
    return attributes;
  }

  // applies a token to shapes, by name. The attributes go to the backend as canonical names. The host resolves the
  // value from the token catalogue and adds resolvedValue to each apply_token op; the facade sends only tokenName,
  // shapeIds and attributes.
  function applyTokenNamed(tokenName, tokenType, refs, properties) {
    if (!Array.isArray(properties) || properties.length === 0) {
      throw new Error("applyToken needs an explicit list of attributes in backend mode, for example [\"fill\"]");
    }
    const attributes = tokenAttributesOf(properties, tokenType);
    core.flushTokens();
    core.enqueue({
      op: "apply_token",
      pageId: refs[0].pageId,
      shapeIds: refs.map(function (ref) {
        return ref.id;
      }),
      tokenName: tokenName,
      attributes: attributes
    });
  }

  // the internal type of a token object, whose type getter gives the Plugin name.
  function tokenTypeOfToken(token) {
    if (typeof token.type !== "string") {
      return undefined;
    }
    const internal = internalTokenTypeOf(token.type);
    return internal === undefined ? token.type : internal;
  }

  function applyTokenToShape(ref, token, properties) {
    if (!token || typeof token.name !== "string") {
      throw new TypeError("applyToken needs a token with a name");
    }
    applyTokenNamed(token.name, tokenTypeOfToken(token), [ref], properties);
  }

  // the table of shape methods. Each method takes the shape reference first.
  const SHAPE_METHODS = {
    resize: function (ref, width, height) {
      resizeShape(ref, width, height);
    },
    rotate: function (ref, angle, center) {
      rotateShape(ref, angle, center);
    },
    clone: function (ref) {
      return cloneShape(ref);
    },
    remove: function (ref) {
      removeShape(ref);
    },
    appendChild: function (ref, child) {
      moveInto(ref, child, undefined);
    },
    insertChild: function (ref, index, child) {
      moveInto(ref, child, requireIndex(index, "index"));
    },
    setParentIndex: function (ref, index) {
      setParentIndex(ref, index);
    },
    bringToFront: function (ref) {
      restackShape(ref, toFront);
    },
    sendToBack: function (ref) {
      restackShape(ref, toBack);
    },
    bringToBack: function (ref) {
      restackShape(ref, toBack);
    },
    bringForward: function (ref) {
      restackShape(ref, oneForward);
    },
    sendBackward: function (ref) {
      restackShape(ref, oneBackward);
    },
    addFlexLayout: function (ref, options) {
      layoutOp(ref, "set_flex_layout", options);
      return layoutView(ref, "flex");
    },
    addGridLayout: function (ref, options) {
      gridLayoutOp(ref, options);
      return layoutView(ref, "grid");
    },
    makeMask: function (ref) {
      core.enqueue({ op: "make_mask", pageId: ref.pageId, groupId: ref.id });
    },
    removeMask: function (ref) {
      core.enqueue({ op: "remove_mask", pageId: ref.pageId, groupId: ref.id });
    },
    detach: function (ref) {
      core.enqueue({ op: "detach", pageId: ref.pageId, ids: [ref.id] });
    },
    swapComponent: function (ref, component) {
      core.enqueue({ op: "swap_component", pageId: ref.pageId, id: ref.id, componentId: componentIdOf(component) });
    },
    resetOverrides: function (ref) {
      core.enqueue({ op: "reset_overrides", pageId: ref.pageId, id: ref.id });
    },
    updateMain: function (ref) {
      core.enqueue({ op: "update_main", pageId: ref.pageId, id: ref.id });
    },
    isComponentInstance: function (ref) {
      return componentFlag(ref, hasComponent);
    },
    isComponentMain: function (ref) {
      return componentFlag(ref, function (record) {
        return record.mainInstance === true;
      });
    },
    isComponentMainInstance: function (ref) {
      return componentFlag(ref, function (record) {
        return record.mainInstance === true;
      });
    },
    isComponentCopy: function (ref) {
      return componentFlag(ref, function (record) {
        return hasComponent(record) && record.mainInstance !== true;
      });
    },
    isComponentCopyInstance: function (ref) {
      return componentFlag(ref, function (record) {
        return hasComponent(record) && record.mainInstance !== true;
      });
    },
    isComponentRoot: function (ref) {
      return componentFlag(ref, function (record) {
        return record.componentRoot === true;
      });
    },
    getPluginData: function (ref, key) {
      return pluginDataOf(ref, "plugin", DEFAULT_NAMESPACE, key);
    },
    setPluginData: function (ref, key, value) {
      setPluginDataOp(ref, "plugin", DEFAULT_NAMESPACE, key, value);
    },
    getSharedPluginData: function (ref, namespace, key) {
      return pluginDataOf(ref, "shared", requireString(namespace, "namespace"), key);
    },
    setSharedPluginData: function (ref, namespace, key, value) {
      setPluginDataOp(ref, "shared", namespace, key, value);
    },
    applyToken: function (ref, token, properties) {
      applyTokenToShape(ref, token, properties);
    },
    getPluginDataKeys: function (ref) {
      return pluginDataKeysOf(ref, "plugin", DEFAULT_NAMESPACE);
    },
    getSharedPluginDataKeys: function (ref, namespace) {
      return pluginDataKeysOf(ref, "shared", requireString(namespace, "namespace"));
    },
    isComponentHead: function (ref) {
      return componentFlag(ref, isHeadRecord);
    },
    component: function (ref) {
      const record = recordOf(ref);
      return record ? componentOf(record) : null;
    },
    componentRefShape: function (ref) {
      const record = recordOf(ref);
      if (!record || !hasComponent(record) || typeof record.shapeRef !== "string") {
        return null;
      }
      return shapeOrNull(ref.pageId, record.shapeRef);
    },
    componentRoot: function (ref) {
      return nearestShape(ref, isRootRecord);
    },
    componentHead: function (ref) {
      return nearestShape(ref, isHeadRecord);
    },
    export: function (ref, options) {
      return exportShapeBytes(ref, options);
    },
    addInteraction: function (ref, trigger, action, delay) {
      return addInteractionTo(ref, trigger, action, delay);
    },
    removeInteraction: function (ref, interaction) {
      removeInteractionAt(ref, requireIndex(interaction && interaction.index, "interaction.index"));
    },
    addRulerGuide: function (ref, orientation, value) {
      return addRuler(ref.pageId, orientation, value, makeShape(ref.pageId, ref.id));
    },
    removeRulerGuide: function (ref, guide) {
      removeRuler(ref.pageId, guide);
    }
  };

  // shape creation inside the current page. Each one is queued and returns a proxy for its temporary id.
  function createIn(opName, fields) {
    const pageId = currentPageId();
    const op = { op: opName, pageId: pageId, parentId: ROOT_ID, x: 0, y: 0, width: 100, height: 100 };
    for (const key of Object.keys(fields)) {
      op[key] = fields[key];
    }
    return makeShape(pageId, core.enqueue(op));
  }

  function createText(characters) {
    return createIn("create_text", {
      name: "Text",
      characters: requireString(characters, "characters"),
      width: 1,
      height: 1,
      growType: "auto-width",
      fills: FILL_BLACK.slice()
    });
  }

  // a path takes its commands or an SVG path string. The default is the bridge default, a diagonal line.
  function createPath(value) {
    const fields = { name: "Path" };
    if (typeof value === "string") {
      fields.d = value;
    } else if (Array.isArray(value)) {
      fields.content = value;
    } else {
      fields.content = [
        { command: "move-to", params: { x: 0, y: 0 } },
        { command: "line-to", params: { x: 100, y: 100 } }
      ];
    }
    return createIn("create_path", fields);
  }

  function createBoolean(boolType, shapes) {
    if (BOOL_TYPES.indexOf(boolType) < 0) {
      throw new TypeError("boolType must be one of union, difference, intersection, exclude");
    }
    const refs = shapeRefs(shapes, "shapes");
    if (refs.length === 0) {
      return null;
    }
    const id = core.enqueue({
      op: "create_boolean",
      pageId: refs[0].pageId,
      name: "Boolean",
      boolType: boolType,
      childIds: refs.map(function (ref) {
        return ref.id;
      })
    });
    return makeShape(refs[0].pageId, id);
  }

  function groupShapes(shapes) {
    const refs = shapeRefs(shapes, "shapes");
    if (refs.length === 0) {
      return null;
    }
    const id = core.enqueue({
      op: "create_group",
      pageId: refs[0].pageId,
      name: "Group",
      childIds: refs.map(function (ref) {
        return ref.id;
      })
    });
    return makeShape(refs[0].pageId, id);
  }

  function ungroupShapes(...groups) {
    for (const group of groups) {
      const ref = requireShape(group, "group");
      core.enqueue({ op: "ungroup", pageId: ref.pageId, id: ref.id });
    }
  }

  // the Plugin API returns the new paths. The backend keeps the ids of the flattened shapes, so the proxies of the
  // input shapes are returned.
  function flattenShapes(shapes) {
    const refs = shapeRefs(shapes, "shapes");
    if (refs.length === 0) {
      return [];
    }
    core.enqueue({
      op: "flatten",
      pageId: refs[0].pageId,
      ids: refs.map(function (ref) {
        return ref.id;
      })
    });
    return refs.map(function (ref) {
      return makeShape(ref.pageId, ref.id);
    });
  }

  // imports the SVG at the origin of the current page. The import flushes the queue first and reloads cached pages.
  function createShapeFromSvg(svg) {
    const pageId = currentPageId();
    const result = core.importSvg({
      fileId: core.fileId(),
      pageId: pageId,
      svg: requireString(svg, "svg"),
      x: 0,
      y: 0
    });
    return result && result.rootId ? shapeOrNull(pageId, result.rootId) : null;
  }

  function createSvgRaw(svg) {
    return createIn("create_svg_raw", { name: "SVG", content: requireString(svg, "svg") });
  }

  // page objects

  function findShapes(pageId, criteria) {
    const predicate = typeof criteria === "function" ? criteria : null;
    const options = predicate || criteria === undefined || criteria === null ? {} : criteria;
    const out = [];
    for (const record of modelOf(pageId).list()) {
      if (record.id === ROOT_ID) {
        continue;
      }
      if (options.type !== undefined && PROP.types[record.type] !== options.type) {
        continue;
      }
      if (options.name !== undefined && record.name !== options.name) {
        continue;
      }
      const shape = makeShape(pageId, record.id);
      if (predicate && !predicate(shape)) {
        continue;
      }
      out.push(shape);
    }
    return out;
  }

  function addRuler(pageId, axis, position, board) {
    if (axis !== "horizontal" && axis !== "vertical") {
      throw new TypeError('axis must be "horizontal" or "vertical"');
    }
    const op = {
      op: "add_ruler_guide",
      pageId: pageId,
      id: core.handle("guide"),
      axis: axis,
      position: requireNumber(position, "position")
    };
    if (board !== undefined && board !== null) {
      op.frameId = requireShape(board, "board").id;
    }
    core.enqueue(op);
    return { id: op.id, axis: axis, position: op.position };
  }

  function removeRuler(pageId, guide) {
    core.enqueue({ op: "remove_ruler_guide", pageId: pageId, id: requireString(guide && guide.id, "guide") });
  }

  function createFlow(pageId, name, startingBoard) {
    const id = core.handle("flow");
    const flowName = requireString(name, "name");
    core.enqueue({
      op: "create_flow",
      pageId: pageId,
      id: id,
      name: flowName,
      startingFrame: requireShape(startingBoard, "startingBoard").id
    });
    return { id: id, name: flowName };
  }

  function removeFlow(pageId, flow) {
    core.enqueue({ op: "remove_flow", pageId: pageId, id: requireString(flow && flow.id, "flow") });
  }

  // the comment threads of the file that sit on this page.
  function findCommentThreads(pageId) {
    const threads = core.rpc("get-comment-threads", { fileId: core.fileId() });
    if (!Array.isArray(threads)) {
      return [];
    }
    return threads.filter(function (thread) {
      return !thread || thread.pageId === undefined || thread.pageId === pageId;
    });
  }

  // the comment is placed on the root frame of the page.
  function addCommentThread(pageId, content, position) {
    const point = position || {};
    return core.rpc("create-comment-thread", {
      fileId: core.fileId(),
      pageId: pageId,
      position: { x: requireNumber(point.x, "position.x"), y: requireNumber(point.y, "position.y") },
      content: requireString(content, "content"),
      frameId: ROOT_ID
    });
  }

  function makePage(pageId, name) {
    const page = {
      id: pageId,
      name: name,
      get root() {
        return makeShape(pageId, ROOT_ID);
      },
      getShapeById: function (id) {
        return shapeOrNull(pageId, id);
      },
      findShapes: function (criteria) {
        return findShapes(pageId, criteria);
      },
      createFlow: function (flowName, startingBoard) {
        return createFlow(pageId, flowName, startingBoard);
      },
      removeFlow: function (flow) {
        removeFlow(pageId, flow);
      },
      addRulerGuide: function (axis, position, board) {
        return addRuler(pageId, axis, position, board);
      },
      removeRulerGuide: function (guide) {
        removeRuler(pageId, guide);
      },
      findCommentThreads: function () {
        return findCommentThreads(pageId);
      },
      addCommentThread: function (content, position) {
        return addCommentThread(pageId, content, position);
      }
    };
    Object.defineProperty(page, "rulerGuides", {
      enumerable: true,
      configurable: true,
      get: notAvailableGetter("page.rulerGuides")
    });
    Object.defineProperty(page, "flows", {
      enumerable: true,
      configurable: true,
      get: notAvailableGetter("page.flows")
    });
    return page;
  }

  function pageById(id) {
    const entry = pageEntries().find(function (candidate) {
      return candidate.id === id;
    });
    return entry ? makePage(entry.id, entry.name) : null;
  }

  // file objects

  function validateFile() {
    const result = core.flush(true);
    const validation = result ? result.validation : null;
    return validation && Array.isArray(validation.errors) ? validation.errors : [];
  }

  function createPage(options) {
    const name = options && options.name !== undefined
      ? requireString(options.name, "name")
      : "Page " + String(pageEntries().length + 1);
    const id = core.handle("page");
    core.enqueue({ op: "create_page", id: id, name: name });
    createdPages.push({ id: id, name: name });
    return makePage(id, name);
  }

  // saves a version of the file after the pending writes, so that the version holds them.
  function saveVersion(label) {
    core.flush(false);
    return core.rpc("create-file-snapshot", { fileId: core.fileId(), label: requireString(label, "label") });
  }

  function findVersions() {
    return core.rpc("get-file-snapshots", { fileId: core.fileId() });
  }

  function currentFileObject() {
    return {
      id: core.fileId(),
      get name() {
        return outline().name;
      },
      get revn() {
        const summary = core.summary();
        return typeof summary.revn === "number" ? summary.revn : outline().revn;
      },
      get pages() {
        return pageEntries().map(function (entry) {
          return makePage(entry.id, entry.name);
        });
      },
      getPageById: function (id) {
        return pageById(requireString(id, "id"));
      },
      createPage: function (options) {
        return createPage(options);
      },
      validate: validateFile,
      saveVersion: saveVersion,
      findVersions: findVersions
    };
  }

  // a file other than the current one has no shape access here, so it gives its plain outline.
  function fileById(fileId) {
    if (fileId === core.fileId()) {
      return currentFileObject();
    }
    const info = core.file(fileId);
    const pages = Array.isArray(info.pages) ? info.pages : [];
    return {
      id: fileId,
      name: info.name,
      revn: info.revn,
      pages: pages.map(function (page) {
        return { id: page.id, name: page.name };
      })
    };
  }

  // libraries

  // the library data of a file, read once per script.
  function libraryData(fileId) {
    if (!libraryCache.has(fileId)) {
      const data = core.rpc("get-mcp-library", { fileId: fileId, kinds: ["colors", "typographies", "components"] });
      libraryCache.set(fileId, data || {});
    }
    return libraryCache.get(fileId);
  }

  // a component, as the Plugin API shows it: its id, name and path, its main instance and the instances it makes.
  // The raw object is the component record of get-mcp-library when one is known.
  function componentHandle(id, name, pageId, raw) {
    const info = raw || {};
    const handle = {
      get id() {
        return core.resolve(id);
      },
      name: name,
      path: info.path === undefined ? null : info.path,
      pageId: pageId,
      mainInstance: function () {
        const page = info.mainInstancePage || pageId;
        if (info.mainInstanceId === undefined || info.mainInstanceId === null || !page) {
          return null;
        }
        return shapeOrNull(page, info.mainInstanceId);
      },
      instance: function (x, y) {
        return instantiateComponent(id, x, y);
      }
    };
    COMPONENT_HANDLES.add(handle);
    return handle;
  }

  // a new instance of a component, placed on the current page at x and y.
  function instantiateComponent(componentId, x, y) {
    const pageId = currentPageId();
    const id = core.handle("instance");
    core.enqueue({
      op: "instantiate_component",
      pageId: pageId,
      componentId: componentId,
      x: numberOr(x, 0),
      y: numberOr(y, 0),
      id: id
    });
    return makeShape(pageId, id);
  }

  // the library component of a shape, or a handle with the id only when the component is not in this file.
  function componentOf(record) {
    if (!hasComponent(record)) {
      return null;
    }
    const components = libraryData(core.fileId()).components || [];
    const found = components.find(function (raw) {
      return raw.id === record.componentId;
    });
    if (found) {
      return componentHandle(found.id, found.name, undefined, found);
    }
    return componentHandle(record.componentId, null, undefined, {});
  }

  // true for a record that roots a component tree.
  function isRootRecord(record) {
    return record.componentRoot === true;
  }

  // true for an instance root, which heads a nested component.
  function isHeadRecord(record) {
    return record.componentRoot === true && hasComponent(record);
  }

  // the nearest shape, the shape itself included, whose record passes the test; null when none does.
  function nearestShape(ref, test) {
    const seen = {};
    let current = ref;
    while (current) {
      const record = recordOf(current);
      if (!record || seen[record.id]) {
        return null;
      }
      seen[record.id] = true;
      if (test(record)) {
        return makeShape(current.pageId, record.id);
      }
      if (!record.parentId || record.parentId === ROOT_ID) {
        return null;
      }
      current = { pageId: current.pageId, id: record.parentId };
    }
    return null;
  }

  // the keys of one plugin data bucket of a shape.
  function pluginDataKeysOf(ref, prefix, namespace) {
    const record = recordOf(ref);
    const bucket = record && record.pluginData ? record.pluginData[prefix + "/" + namespace] : undefined;
    return bucket ? Object.keys(bucket) : [];
  }

  function createComponent(shapes, options) {
    const refs = shapeRefs(shapes, "shapes");
    if (refs.length === 0) {
      throw new Error("createComponent needs at least one shape");
    }
    const id = core.handle("component");
    const name = nameOption(options, undefined);
    core.enqueue({
      op: "create_component",
      pageId: refs[0].pageId,
      shapeIds: refs.map(function (ref) {
        return ref.id;
      }),
      name: name,
      id: id
    });
    return componentHandle(id, name, refs[0].pageId);
  }

  // a color or typography made by this script. Its id is the handle that the create op gave it, until a flush turns the
  // handle into a uuid. A setter queues an update of its one field, and remove queues the delete. The nested id is
  // resolved here, because the core resolves only the top-level values of an op.
  function libraryEntryObject(kind, id, initial, checks) {
    const current = Object.assign({}, initial);
    const entry = {
      get id() {
        return core.resolve(id);
      },
      remove: function () {
        core.enqueue({ op: "delete_" + kind, id: core.resolve(id) });
      }
    };
    Object.keys(checks).forEach(function (field) {
      Object.defineProperty(entry, field, {
        enumerable: true,
        configurable: true,
        get: function () {
          return current[field];
        },
        set: function (value) {
          const checked = checks[field](value, field);
          current[field] = checked;
          const data = { id: core.resolve(id) };
          data[field] = checked;
          const op = { op: "update_" + kind };
          op[kind] = data;
          core.enqueue(op);
        }
      });
    });
    return entry;
  }

  function libraryObject(fileId, name, isLocal) {
    const library = {
      id: fileId,
      name: name,
      get colors() {
        return libraryData(fileId).colors || [];
      },
      get typographies() {
        return libraryData(fileId).typographies || [];
      },
      get components() {
        return (libraryData(fileId).components || []).map(function (raw) {
          return componentHandle(raw.id, raw.name, undefined, raw);
        });
      }
    };
    if (isLocal) {
      Object.defineProperty(library, "tokens", {
        enumerable: true,
        configurable: true,
        get: function () {
          return tokenCatalogue();
        }
      });
      library.createColor = function (options) {
        const opts = options || {};
        const checks = {
          name: requireString,
          color: requireString,
          opacity: requireNumber,
          path: requireString
        };
        const id = core.handle("color");
        const color = { id: id, name: nameOption(options, "Color") };
        // the schema needs one paint, so a color without one is black, as the Plugin API makes it
        color.color = opts.color === undefined ? "#000000" : checks.color(opts.color, "color");
        if (opts.opacity !== undefined) {
          color.opacity = checks.opacity(opts.opacity, "opacity");
        }
        if (opts.path !== undefined) {
          color.path = checks.path(opts.path, "path");
        }
        core.enqueue({ op: "create_color", color: color });
        const initial = { name: color.name, color: color.color, opacity: color.opacity, path: color.path };
        return libraryEntryObject("color", id, initial, checks);
      };
      library.createTypography = function (options) {
        const opts = options || {};
        const checks = {
          name: requireString,
          path: requireString,
          fontId: requireString,
          fontFamily: requireString,
          fontVariantId: requireString,
          fontSize: requireString,
          fontWeight: requireString,
          fontStyle: requireString,
          lineHeight: requireString,
          letterSpacing: requireString,
          textTransform: requireString
        };
        const id = core.handle("typography");
        const typography = { id: id, name: nameOption(options, "Typography") };
        Object.keys(checks).forEach(function (field) {
          if (field !== "name" && opts[field] !== undefined) {
            typography[field] = checks[field](opts[field], field);
          }
        });
        core.enqueue({ op: "create_typography", typography: typography });
        const initial = {};
        Object.keys(checks).forEach(function (field) {
          initial[field] = typography[field];
        });
        return libraryEntryObject("typography", id, initial, checks);
      };
      library.createComponent = createComponent;
    }
    return library;
  }

  // fonts

  function fontVariant(key) {
    if (hasOwn(FONT_VARIANTS, key)) {
      return Object.assign({ id: key }, FONT_VARIANTS[key]);
    }
    return { id: key, name: key, fontWeight: /^[0-9]+$/.test(key) ? key : "400", fontStyle: "normal" };
  }

  function fontTable() {
    return typeof FONT_CATALOG === "undefined" ? [] : FONT_CATALOG;
  }

  function fontObject(entry) {
    return {
      name: entry.family,
      id: entry.id,
      fontId: entry.id,
      fontFamily: entry.family,
      fontVariantId: "regular",
      fontWeight: "400",
      fontStyle: "normal",
      variants: (entry.variants || []).map(fontVariant)
    };
  }

  function allFonts() {
    return fontTable().map(fontObject);
  }

  function findFonts(predicate) {
    return allFonts().filter(predicate);
  }

  // utilities

  // the bounding box of one shape, or of a list of shapes, and its center.
  function centerOf(value) {
    const items = Array.isArray(value) ? value : [value];
    const boxes = [];
    for (const item of items) {
      const record = recordOf(requireShape(item, "shape"));
      if (record) {
        boxes.push(rectOf(record));
      }
    }
    if (boxes.length === 0) {
      return null;
    }
    const minX = Math.min.apply(null, boxes.map(function (box) { return box.x; }));
    const minY = Math.min.apply(null, boxes.map(function (box) { return box.y; }));
    const maxX = Math.max.apply(null, boxes.map(function (box) { return box.x + box.width; }));
    const maxY = Math.max.apply(null, boxes.map(function (box) { return box.y + box.height; }));
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  }

  function isOfType(value, pluginType) {
    const ref = refOf(value);
    if (!ref) {
      return false;
    }
    const record = recordOf(ref);
    return !!record && PROP.types[record.type] === pluginType;
  }

  // the id of a shape for a nested value, such as an interaction destination. A shape created in this call is
  // flushed first, because the backend resolves temporary ids only at the top level of an operation.
  function settledIdOf(value, label) {
    const id = requireShape(value, label).id;
    const resolved = core.resolve(id);
    if (isHandle(resolved)) {
      core.flush(false);
      return core.resolve(id);
    }
    return resolved;
  }

  // prototyping. An interaction is kept as the backend map, and read back under the Plugin API names.

  // the animation of a Plugin API value, as the backend animation map.
  function animationData(animation) {
    if (!animation || typeof animation !== "object") {
      throw new TypeError("animation must be an object with a type");
    }
    return withoutUndefined({
      animationType: requireString(animation.type, "animation.type"),
      duration: animation.duration,
      easing: animation.easing,
      way: animation.way,
      direction: animation.direction,
      offsetEffect: animation.offsetEffect
    });
  }

  // the Plugin API value of a backend animation map, or undefined when there is none.
  function animationView(raw) {
    if (!raw || typeof raw !== "object") {
      return undefined;
    }
    return withoutUndefined({
      type: raw.animationType,
      duration: raw.duration,
      easing: raw.easing,
      way: raw.way,
      direction: raw.direction,
      offsetEffect: raw.offsetEffect
    });
  }

  // the Plugin API name of a backend action type.
  function actionNameOf(actionType) {
    for (const name of Object.keys(ACTION_TYPES)) {
      if (ACTION_TYPES[name] === actionType) {
        return name;
      }
    }
    return actionType;
  }

  // the backend interaction map of a trigger, an action and an optional delay.
  function interactionData(eventType, action, delay) {
    if (!action || typeof action !== "object") {
      throw new TypeError("action must be an object with a type");
    }
    if (!hasOwn(ACTION_TYPES, action.type)) {
      throw new TypeError("action.type must be one of " + Object.keys(ACTION_TYPES).join(", "));
    }
    const data = { eventType: eventType, actionType: ACTION_TYPES[action.type] };
    if (delay !== undefined && delay !== null) {
      data.delay = requireNumber(delay, "delay");
    }
    if (action.type === "previous-screen") {
      return data;
    }
    if (action.type === "open-url") {
      data.url = requireString(action.url, "action.url");
      return data;
    }
    if (action.type === "navigate-to" && (action.destination === undefined || action.destination === null)) {
      throw new TypeError("navigate-to needs a destination board");
    }
    if (action.destination !== undefined && action.destination !== null) {
      data.destination = settledIdOf(action.destination, "action.destination");
    }
    if (action.type === "navigate-to") {
      data.preserveScroll = action.preserveScrollPosition === true;
    }
    if (action.relativeTo !== undefined && action.relativeTo !== null) {
      data.positionRelativeTo = settledIdOf(action.relativeTo, "action.relativeTo");
    }
    if (action.position !== undefined) {
      data.overlayPosType = action.position;
    }
    if (action.manualPositionLocation) {
      data.overlayPosition = {
        x: requireNumber(action.manualPositionLocation.x, "manualPositionLocation.x"),
        y: requireNumber(action.manualPositionLocation.y, "manualPositionLocation.y")
      };
    }
    if (action.closeClickOutside !== undefined) {
      data.closeClickOutside = action.closeClickOutside === true;
    }
    if (action.backgroundOverlay !== undefined) {
      data.backgroundOverlay = action.backgroundOverlay === true;
    }
    if (action.animation) {
      data.animation = animationData(action.animation);
    }
    return data;
  }

  // the Plugin API view of one interaction of a shape record, with the index it has on the shape.
  function interactionView(ref, raw, index) {
    const action = withoutUndefined({
      type: actionNameOf(raw.actionType),
      destination: raw.destination ? shapeOrNull(ref.pageId, raw.destination) : undefined,
      url: raw.url,
      preserveScrollPosition: raw.preserveScroll,
      relativeTo: raw.positionRelativeTo ? shapeOrNull(ref.pageId, raw.positionRelativeTo) : undefined,
      position: raw.overlayPosType,
      manualPositionLocation: raw.overlayPosition,
      closeClickOutside: raw.closeClickOutside,
      backgroundOverlay: raw.backgroundOverlay,
      animation: animationView(raw.animation)
    });
    return {
      index: index,
      trigger: raw.eventType,
      delay: raw.delay === undefined ? null : raw.delay,
      action: action,
      remove: function () {
        removeInteractionAt(ref, index);
      }
    };
  }

  // the interactions of a shape record.
  function interactionsOf(ref, record) {
    const list = Array.isArray(record.interactions) ? record.interactions : [];
    return list.map(function (raw, index) {
      return interactionView(ref, raw, index);
    });
  }

  function addInteractionTo(ref, trigger, action, delay) {
    const eventType = requireString(trigger, "trigger");
    if (TRIGGERS.indexOf(eventType) < 0) {
      throw new TypeError("trigger must be one of " + TRIGGERS.join(", "));
    }
    const data = interactionData(eventType, action, delay);
    const record = requireRecord(ref);
    const index = Array.isArray(record.interactions) ? record.interactions.length : 0;
    core.enqueue({ op: "add_interaction", pageId: ref.pageId, id: ref.id, interaction: data });
    return interactionView(ref, data, index);
  }

  function removeInteractionAt(ref, index) {
    core.enqueue({ op: "remove_interaction", pageId: ref.pageId, id: ref.id, index: requireIndex(index, "index") });
  }

  // alignment and distribution. Each one queues a single op for the shapes, which must share a page.

  function alignShapes(shapes, dimension, position) {
    const refs = shapeRefs(shapes, "shapes");
    if (!hasOwn(ALIGN_AXES[dimension], position)) {
      throw new TypeError("direction must be one of " + Object.keys(ALIGN_AXES[dimension]).join(", "));
    }
    if (refs.length === 0) {
      return;
    }
    core.enqueue({
      op: "align",
      pageId: refs[0].pageId,
      ids: refs.map(function (ref) {
        return ref.id;
      }),
      axis: ALIGN_AXES[dimension][position]
    });
  }

  function distributeShapes(shapes, dimension) {
    const refs = shapeRefs(shapes, "shapes");
    if (refs.length === 0) {
      return;
    }
    core.enqueue({
      op: "distribute",
      pageId: refs[0].pageId,
      ids: refs.map(function (ref) {
        return ref.id;
      }),
      axis: dimension
    });
  }

  // colours. A paint is a fill or a stroke record; text fills are read and written through the text content.

  function sameColor(a, b) {
    return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
  }

  // adds the colour paints of one list to the groups, one group per colour and opacity.
  function collectPaints(groups, ref, property, paints, colorKey, opacityKey) {
    for (const paint of Array.isArray(paints) ? paints : []) {
      if (!paint || typeof paint[colorKey] !== "string") {
        continue;
      }
      const opacity = typeof paint[opacityKey] === "number" ? paint[opacityKey] : 1;
      let group = groups.find(function (entry) {
        return sameColor(entry.color, paint[colorKey]) && entry.opacity === opacity;
      });
      if (!group) {
        group = { color: paint[colorKey], opacity: opacity, shapesInfo: [] };
        groups.push(group);
      }
      group.shapesInfo.push({ property: property, shapeId: core.resolve(ref.id) });
    }
  }

  function shapesColorsOf(shapes) {
    const groups = [];
    for (const ref of shapeRefs(shapes, "shapes")) {
      collectPaints(groups, ref, "fill", readMember(ref, "fills"), "fillColor", "fillOpacity");
      collectPaints(groups, ref, "stroke", readMember(ref, "strokes"), "strokeColor", "strokeOpacity");
    }
    return groups;
  }

  function colorArgument(value, label) {
    if (!value || typeof value.color !== "string") {
      throw new TypeError(label + " must be a colour with a color string");
    }
    return { color: value.color, opacity: typeof value.opacity === "number" ? value.opacity : undefined };
  }

  // a copy of the paints with the old colour replaced, and whether any paint changed.
  function recolor(paints, colorKey, opacityKey, from, to) {
    let changed = false;
    const out = (Array.isArray(paints) ? paints : []).map(function (paint) {
      if (!paint || !sameColor(paint[colorKey], from.color)) {
        return paint;
      }
      changed = true;
      const next = Object.assign({}, paint);
      next[colorKey] = to.color;
      if (to.opacity !== undefined) {
        next[opacityKey] = to.opacity;
      }
      return next;
    });
    return { changed: changed, paints: out };
  }

  function replaceShapesColor(shapes, oldColor, newColor) {
    const from = colorArgument(oldColor, "oldColor");
    const to = colorArgument(newColor, "newColor");
    for (const ref of shapeRefs(shapes, "shapes")) {
      const fills = recolor(readMember(ref, "fills"), "fillColor", "fillOpacity", from, to);
      if (fills.changed) {
        writeMember(ref, "fills", fills.paints);
      }
      const strokes = recolor(readMember(ref, "strokes"), "strokeColor", "strokeOpacity", from, to);
      if (strokes.changed) {
        writeMember(ref, "strokes", strokes.paints);
      }
    }
  }

  // media and export. The host stores the image and renders the file at once, so the results are plain values.

  // the Plugin API image data of a stored media object.
  function imageDataOf(media) {
    return {
      id: media.id,
      name: media.name,
      width: media.width,
      height: media.height,
      mtype: media.mtype,
      keepAspectRatio: true
    };
  }

  function uploadUrl(name, url) {
    const media = core.uploadMediaUrl({
      fileId: core.fileId(),
      name: requireString(name, "name"),
      url: requireString(url, "url")
    });
    return imageDataOf(media);
  }

  function uploadData(name, bytes, mimeType) {
    if (bytes === null || bytes === undefined || typeof bytes.length !== "number") {
      throw new TypeError("bytes must be a Uint8Array");
    }
    const content = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    const media = core.uploadMediaData({
      fileId: core.fileId(),
      name: requireString(name, "name"),
      mimeType: requireString(mimeType, "mimeType"),
      base64: encodeBase64(content)
    });
    return imageDataOf(media);
  }

  // renders a shape to a Uint8Array. Pending writes are flushed first, so the exporter sees the shape.
  function exportShapeBytes(ref, options) {
    const opts = options || {};
    const format = opts.type === undefined ? "png" : requireString(opts.type, "type");
    const scale = opts.scale === undefined ? 1 : requireNumber(opts.scale, "scale");
    core.flush(false);
    const file = core.exportShape({
      fileId: core.fileId(),
      pageId: ref.pageId,
      objectId: core.resolve(ref.id),
      format: format,
      scale: scale
    });
    return decodeBase64(file.base64);
  }

  // downloads the stored image of a fill as a Uint8Array.
  function exportFillBytes(mediaId) {
    core.flush(false);
    const file = core.exportShape({ fileId: core.fileId(), mediaId: requireString(mediaId, "mediaId") });
    return decodeBase64(file.base64);
  }

  // base64 text of bytes, and the bytes of base64 text. The sandbox has neither btoa nor atob.
  function encodeBase64(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i];
      const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      const n = (b0 << 16) | (b1 << 8) | b2;
      out += BASE64_CHARS.charAt((n >> 18) & 63) + BASE64_CHARS.charAt((n >> 12) & 63);
      out += i + 1 < bytes.length ? BASE64_CHARS.charAt((n >> 6) & 63) : "=";
      out += i + 2 < bytes.length ? BASE64_CHARS.charAt(n & 63) : "=";
    }
    return out;
  }

  function decodeBase64(text) {
    const clean = String(text).replace(/[^A-Za-z0-9+\/]/g, "");
    const bytes = [];
    let buffer = 0;
    let bits = 0;
    for (let i = 0; i < clean.length; i++) {
      buffer = ((buffer << 6) | BASE64_CHARS.indexOf(clean.charAt(i))) & 0xffffff;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((buffer >> bits) & 255);
      }
    }
    return new Uint8Array(bytes);
  }

  // tokens. Token writes are queued. A read of the catalogue flushes the queued token writes first, so a read sees them.

  // the token catalogue of the file, as get-mcp-tokens reports it, after the queued token writes are flushed.
  function tokenState() {
    core.flushTokens();
    const data = core.rpc("get-mcp-tokens", { fileId: core.fileId() }) || {};
    return {
      sets: Array.isArray(data.sets) ? data.sets : [],
      themes: Array.isArray(data.themes) ? data.themes : [],
      tokens: Array.isArray(data.tokens) ? data.tokens : [],
      activeThemes: Array.isArray(data.activeThemes) ? data.activeThemes : [],
      activeSets: Array.isArray(data.activeSets) ? data.activeSets : []
    };
  }

  // a token, from its catalogue record.
  function tokenObject(raw) {
    return {
      get id() {
        return core.resolve(raw.id);
      },
      get name() {
        return raw.name;
      },
      get type() {
        return pluginTokenTypeOf(raw.type);
      },
      get value() {
        return raw.value;
      },
      get description() {
        return raw.description;
      },
      remove: function () {
        core.enqueue({ op: "delete_token", setId: raw.setId, id: raw.id });
      },
      applyToShapes: function (shapes, properties) {
        const refs = shapeRefs(shapes, "shapes");
        if (refs.length > 0) {
          applyTokenNamed(raw.name, raw.type, refs, properties);
        }
      }
    };
  }

  // the tokens of one type group, as the Plugin API pairs them: [type, tokens] in order of first appearance.
  function tokensGroupedByType(tokens) {
    const groups = [];
    for (const token of tokens) {
      const type = token.type;
      let group = groups.find(function (entry) {
        return entry[0] === type;
      });
      if (!group) {
        group = [type, []];
        groups.push(group);
      }
      group[1].push(token);
    }
    return groups;
  }

  // flips the active state of a theme or of a set, and queues the whole status, because the compiler sets it at once.
  function toggleTokenStatus(isTheme, id) {
    const state = tokenState();
    const themeIds = state.activeThemes.slice();
    const setIds = state.activeSets.slice();
    const list = isTheme ? themeIds : setIds;
    const target = core.resolve(id);
    const at = list.indexOf(target);
    if (at >= 0) {
      list.splice(at, 1);
    } else {
      list.push(target);
    }
    core.enqueue({ op: "set_tokens_status", themeIds: themeIds, setIds: setIds });
  }

  function addTokenTo(setId, options) {
    const opts = options || {};
    if (opts.value === undefined) {
      throw new TypeError("value is required");
    }
    const internal = typeof opts.type === "string" ? internalTokenTypeOf(opts.type) : undefined;
    if (internal === undefined) {
      const names = Object.keys(TOKEN_TYPE_PLUGIN_NAMES).map(function (key) {
        return TOKEN_TYPE_PLUGIN_NAMES[key];
      });
      throw new TypeError("type must be one of " + names.join(", "));
    }
    const id = core.handle("token");
    const op = {
      op: "create_token",
      setId: setId,
      id: id,
      type: internal,
      name: requireString(opts.name, "name"),
      value: opts.value
    };
    if (opts.description !== undefined) {
      op.description = requireString(opts.description, "description");
    }
    core.enqueue(op);
    return tokenObject({
      id: id,
      setId: setId,
      name: opts.name,
      type: internal,
      value: opts.value,
      description: opts.description
    });
  }

  // a token set, from its catalogue record and the token records of the file.
  function tokenSetObject(raw, allTokens) {
    const tokens = allTokens
      .filter(function (token) {
        return token.setId === raw.id;
      })
      .map(tokenObject);
    return {
      get id() {
        return core.resolve(raw.id);
      },
      get name() {
        return raw.name;
      },
      get active() {
        return raw.active === true;
      },
      get tokens() {
        return tokens.slice();
      },
      get tokensByType() {
        return tokensGroupedByType(tokens);
      },
      toggleActive: function () {
        toggleTokenStatus(false, raw.id);
      },
      getTokenById: function (id) {
        return tokens.find(function (token) {
          return token.id === id;
        });
      },
      addToken: function (options) {
        return addTokenTo(core.resolve(raw.id), options);
      },
      remove: function () {
        core.enqueue({ op: "delete_token_set", id: core.resolve(raw.id) });
      }
    };
  }

  // a token theme. Its active sets are the sets it holds that are active.
  function tokenThemeObject(raw, sets) {
    return {
      get id() {
        return core.resolve(raw.id);
      },
      get group() {
        return raw.group;
      },
      get name() {
        return raw.name;
      },
      get active() {
        return raw.active === true;
      },
      get activeSets() {
        const held = Array.isArray(raw.sets) ? raw.sets : [];
        return sets.filter(function (set) {
          return held.indexOf(set.name) >= 0 && set.active;
        });
      },
      toggleActive: function () {
        toggleTokenStatus(true, raw.id);
      },
      remove: function () {
        core.enqueue({ op: "delete_theme", id: core.resolve(raw.id) });
      }
    };
  }

  function addSetTo(options) {
    const opts = options || {};
    const name = requireString(opts.name, "name");
    const active = opts.active === true;
    const id = core.handle("tokenSet");
    core.enqueue({ op: "create_token_set", id: id, name: name, active: active });
    return tokenSetObject({ id: id, name: name, active: active }, []);
  }

  function addThemeTo(options) {
    const opts = options || {};
    const group = requireString(opts.group, "group");
    const name = requireString(opts.name, "name");
    const id = core.handle("tokenTheme");
    core.enqueue({ op: "create_theme", id: id, group: group, name: name, sets: [] });
    return tokenThemeObject({ id: id, group: group, name: name, active: false, sets: [] }, []);
  }

  // the token catalogue of the current file: its sets, themes and tokens, and helpers to find them.
  function tokenCatalogue() {
    const state = tokenState();
    const sets = state.sets.map(function (raw) {
      return tokenSetObject(raw, state.tokens);
    });
    const themes = state.themes.map(function (raw) {
      return tokenThemeObject(raw, sets);
    });
    const allTokens = state.tokens.map(tokenObject);
    return {
      get isEditableTokens() {
        return true;
      },
      get sets() {
        return sets.slice();
      },
      get themes() {
        return themes.slice();
      },
      get tokens() {
        return allTokens.slice();
      },
      get activeSets() {
        return sets.filter(function (set) {
          return set.active;
        });
      },
      get activeThemes() {
        return themes.filter(function (theme) {
          return theme.active;
        });
      },
      addSet: function (options) {
        return addSetTo(options);
      },
      addTheme: function (options) {
        return addThemeTo(options);
      },
      getSetById: function (id) {
        return sets.find(function (set) {
          return set.id === id;
        });
      },
      getThemeById: function (id) {
        return themes.find(function (theme) {
          return theme.id === id;
        });
      },
      findById: function (id) {
        return allTokens.find(function (token) {
          return token.id === id;
        }) || null;
      },
      findByName: function (name) {
        return allTokens.find(function (token) {
          return token.name === name;
        }) || null;
      }
    };
  }

  // sets or clears the token source of the file, by the library it names.
  function setTokensSource(value) {
    const libraryId = value === null || value === undefined ? null : requireString(value.id, "tokensSource.id");
    core.enqueue({ op: "set_tokens_source", libraryId: libraryId });
  }

  // connects a library by id, and returns it once the backend has linked it.
  function connectLibrary(libraryId) {
    const id = requireString(libraryId, "libraryId");
    core.rpc("link-file-to-library", { fileId: core.fileId(), libraryId: id });
    const shared = core.rpc("get-team-shared-files", { teamId: teamIdOption(undefined) });
    const found = Array.isArray(shared)
      ? shared.find(function (file) {
          return file.id === id;
        })
      : undefined;
    return libraryObject(id, found && found.name ? found.name : id, false);
  }

  // the object of the global penpot

  const PROP = PROPERTY_MAP;

  const flags = Object.freeze({ naturalChildOrdering: true, throwValidationErrors: true });

  const viewport = {
    get center() {
      return null;
    },
    set center(value) {
      throw unavailable("viewport");
    },
    get zoom() {
      return null;
    },
    set zoom(value) {
      throw unavailable("viewport");
    },
    get bounds() {
      return null;
    },
    zoomReset: notAvailableFn("viewport"),
    zoomToFitAll: notAvailableFn("viewport"),
    zoomIntoView: notAvailableFn("viewport")
  };

  const ui = {
    get size() {
      return null;
    },
    open: notAvailableFn("ui.open"),
    resize: notAvailableFn("ui.resize"),
    sendMessage: notAvailableFn("ui.sendMessage"),
    onMessage: notAvailableFn("ui.onMessage")
  };

  const history = {
    undoBlockBegin: function () {
      return undefined;
    },
    undoBlockFinish: function () {
      return undefined;
    }
  };

  const utils = {
    geometry: {
      center: centerOf
    },
    types: {
      isShape: function (value) {
        return refOf(value) !== null;
      },
      isBoard: function (value) {
        return isOfType(value, "board");
      },
      isGroup: function (value) {
        return isOfType(value, "group");
      },
      isBoolean: function (value) {
        return isOfType(value, "boolean");
      },
      isBool: function (value) {
        return isOfType(value, "boolean");
      },
      isRectangle: function (value) {
        return isOfType(value, "rectangle");
      },
      isEllipse: function (value) {
        return isOfType(value, "ellipse");
      },
      isText: function (value) {
        return isOfType(value, "text");
      },
      isPath: function (value) {
        return isOfType(value, "path");
      },
      isImage: function (value) {
        return isOfType(value, "image");
      },
      isSvgRaw: function (value) {
        return isOfType(value, "svg-raw");
      },
      isSVG: function (value) {
        return isOfType(value, "svg-raw");
      },
      isComponent: function (value) {
        return COMPONENT_HANDLES.has(value);
      }
    }
  };

  const fonts = {
    get all() {
      return allFonts();
    },
    findById: function (id) {
      const found = findFonts(function (font) {
        return font.fontId === id;
      });
      return found.length > 0 ? found[0] : null;
    },
    findByName: function (name) {
      const found = findFonts(function (font) {
        return font.name === name;
      });
      return found.length > 0 ? found[0] : null;
    },
    findAllById: function (id) {
      return findFonts(function (font) {
        return font.fontId === id;
      });
    },
    findAllByName: function (name) {
      return findFonts(function (font) {
        return font.name === name;
      });
    }
  };

  const library = {
    get local() {
      return libraryObject(core.fileId(), outline().name, true);
    },
    get connected() {
      const libraries = outline().libraries;
      return (Array.isArray(libraries) ? libraries : []).map(function (lib) {
        return libraryObject(lib.id, lib.name, false);
      });
    },
    availableLibraries: function () {
      return core.rpc("get-team-shared-files", { teamId: teamIdOption(undefined) });
    },
    connectLibrary: function (libraryId) {
      return connectLibrary(libraryId);
    }
  };
  Object.defineProperty(library, "tokensSource", {
    enumerable: true,
    configurable: true,
    get: notAvailableGetter("library.tokensSource"),
    set: function (value) {
      setTokensSource(value);
    }
  });

  // the penpot global. Its members create, read and write the current file through the core.
  const penpot = {
    theme: "light",
    viewport: viewport,
    ui: ui,
    utils: utils,
    library: library,
    fonts: fonts,
    flags: flags,
    history: history,
    get currentFile() {
      return currentFileObject();
    },
    get currentPage() {
      const entry = currentPageEntry();
      return entry ? makePage(entry.id, entry.name) : null;
    },
    get root() {
      const entry = currentPageEntry();
      return entry ? makeShape(entry.id, ROOT_ID) : null;
    },
    get selection() {
      return [];
    },
    set selection(value) {
      throw unavailable("selection");
    },
    getPage: function (id) {
      const page = pageById(requireString(id, "id"));
      if (!page) {
        throw new Error("page " + id + " was not found in the current file");
      }
      return page;
    },
    createPage: function (options) {
      return createPage(options);
    },
    createBoard: function () {
      return createIn("create_board", { name: "Board" });
    },
    createRectangle: function () {
      return createIn("create_rect", { name: "Rectangle" });
    },
    createEllipse: function () {
      return createIn("create_ellipse", { name: "Ellipse" });
    },
    createText: createText,
    createPath: createPath,
    createBoolean: createBoolean,
    group: groupShapes,
    ungroup: ungroupShapes,
    flatten: flattenShapes,
    createShapeFromSvg: createShapeFromSvg,
    createSvgRaw: createSvgRaw,
    waitForLayoutUpdate: function () {
      core.flush();
      return undefined;
    },
    closePlugin: function () {
      return undefined;
    },
    on: notAvailableFn("on"),
    off: notAvailableFn("off"),
    openPage: notAvailableFn("openPage"),
    openViewer: notAvailableFn("openViewer"),
    createImage: notAvailableFn("createImage"),
    createShapeFromSvgWithImages: notAvailableFn("createShapeFromSvgWithImages"),
    shapesColors: function (shapes) {
      return shapesColorsOf(shapes);
    },
    replaceColor: function (shapes, oldColor, newColor) {
      replaceShapesColor(shapes, oldColor, newColor);
    },
    uploadMediaUrl: function (name, url) {
      return uploadUrl(name, url);
    },
    uploadMediaData: function (name, bytes, mimeType) {
      return uploadData(name, bytes, mimeType);
    },
    generateMarkup: notAvailableFn("generateMarkup"),
    generateStyle: notAvailableFn("generateStyle"),
    generateFontFaces: notAvailableFn("generateFontFaces"),
    addListener: notAvailableFn("addListener"),
    removeListener: notAvailableFn("removeListener"),
    alignHorizontal: function (shapes, direction) {
      alignShapes(shapes, "horizontal", direction);
    },
    alignVertical: function (shapes, direction) {
      alignShapes(shapes, "vertical", direction);
    },
    distributeHorizontal: function (shapes) {
      distributeShapes(shapes, "horizontal");
    },
    distributeVertical: function (shapes) {
      distributeShapes(shapes, "vertical");
    },
    createVariantFromComponents: notAvailableFn("createVariantFromComponents")
  };
  defineNotAvailable(penpot, "currentUser");
  defineNotAvailable(penpot, "activeUsers");
  defineNotAvailable(penpot, "localStorage");

  // the penpotMgmt global. Team, project and file ids default to the team, project and file of the current file.

  function teamIdOption(options) {
    const teamId = options && typeof options === "object" ? options.teamId : options;
    if (typeof teamId === "string" && teamId.length > 0) {
      return teamId;
    }
    const current = outline().teamId;
    if (current) {
      return current;
    }
    throw new Error("teamId is required");
  }

  function projectIdOption(projectId) {
    if (typeof projectId === "string" && projectId.length > 0) {
      return projectId;
    }
    const current = outline().projectId;
    if (current) {
      return current;
    }
    throw new Error("projectId is required");
  }

  const penpotMgmt = {
    listTeams: function () {
      return core.rpc("get-teams", {});
    },
    listProjects: function (options) {
      return core.rpc("get-projects", { teamId: teamIdOption(options) });
    },
    listFiles: function (projectId) {
      return core.rpc("get-project-files", { projectId: projectIdOption(projectId) });
    },
    getFile: function (fileId) {
      return fileById(requireString(fileId, "fileId"));
    },
    openFile: function (fileId) {
      core.setFile(requireString(fileId, "fileId"));
      return undefined;
    },
    createTeam: function (options) {
      return core.rpc("create-team", { name: requireString(options && options.name, "name") });
    },
    listDeletedProjects: notAvailableFn("penpotMgmt.listDeletedProjects"),
    listDeletedFiles: function (options) {
      return core.rpc("get-team-deleted-files", { teamId: teamIdOption(options) });
    },
    on: notAvailableFn("penpotMgmt.on"),
    off: notAvailableFn("penpotMgmt.off")
  };
  defineNotAvailable(penpotMgmt, "workspace");

  // every script starts with empty per-call caches. This wrapper runs before the core's runner.
  const runCore = global.__runScript;
  global.__runScript = function (code, fileId, pageId) {
    libraryCache = new Map();
    createdPages = [];
    return runCore(code, fileId, pageId);
  };

  global.__codec = {
    encodeBase64: encodeBase64,
    decodeBase64: decodeBase64,
    exportFill: exportFillBytes
  };
  global.penpot = penpot;
  global.penpotMgmt = penpotMgmt;
})(globalThis);
`;
