/**
 * JavaScript of the sandbox core, evaluated once in the guest before any script runs.
 *
 * The core keeps a working copy of the pages a script reads, queues the operations the script writes, and sends
 * them to the host in flushes. As it queues an attribute update or an appendChild move of a shape created in the
 * same batch, it folds the op into the create of that shape, so the cap of 5000 operations per script counts the
 * ops after folding. It also defines the runner that compiles and calls the user code, and the console that
 * captures log output. Guest code is synchronous: nothing here returns a promise or uses timers.
 */
export const CORE_SOURCE: string = String.raw`
(function (global) {
  "use strict";

  const ROOT_ID = "00000000-0000-0000-0000-000000000000";
  const HANDLE_PREFIX = "$tmp:";
  // ops queued per script, counted after folding, so it is the count that the host and the backend receive
  const MAX_OPERATIONS = 5000;
  const MAX_PAGE_LOADS = 20;
  const OPERATION_LIMIT_MESSAGE =
    "execute_code allows at most 5000 operations per script; split the work into several calls";
  const PAGE_LIMIT_MESSAGE = "execute_code loads at most 20 pages per script";
  const AWAIT_PATTERN = /\bawait\b/;
  const TOKEN_WRITE_PATTERN = /token|theme|toggle_set/;
  const AWAIT_HINT =
    "execute_code runs synchronously in backend mode: penpot calls return values directly; remove await";

  // default names and the ops that get a handle when they carry no id
  const DEFAULT_NAMES = {
    frame: "Board",
    rect: "Rectangle",
    circle: "Ellipse",
    text: "Text",
    path: "Path",
    image: "Image",
    "svg-raw": "SVG",
    group: "Group",
    bool: "Boolean"
  };
  const ID_CREATE_OPS = new Set([
    "create_board",
    "create_rect",
    "create_ellipse",
    "create_text",
    "create_path",
    "create_image",
    "create_svg_raw",
    "create_group",
    "create_boolean"
  ]);

  // log text of the current call, read with takeLog
  let logText = "";
  // state of the current call, replaced by beginCall
  let state = newState(null, null);

  function newState(fileId, pageId) {
    return {
      fileId: fileId,
      pageId: pageId,
      pending: [],
      folds: new FoldIndex(),
      pages: new Map(),
      files: new Map(),
      aliases: new Map(),
      handleCount: 0,
      opCount: 0,
      pageLoads: 0,
      revn: null,
      warnings: []
    };
  }

  function beginCall(fileId, pageId) {
    logText = "";
    state = newState(fileId, pageId);
  }

  // ids and handles

  function isHandle(value) {
    return typeof value === "string" && value.indexOf(HANDLE_PREFIX) === 0;
  }

  // maps a handle to the uuid that a flush gave it; any other id comes back unchanged.
  function resolveId(id) {
    if (isHandle(id) && state.aliases.has(id)) {
      return state.aliases.get(id);
    }
    return id;
  }

  function handle(prefix) {
    state.handleCount += 1;
    const label = prefix === undefined ? "s" : String(prefix);
    return HANDLE_PREFIX + label + state.handleCount;
  }

  function resolveValue(value) {
    if (Array.isArray(value)) {
      return value.map((item) => resolveId(item));
    }
    return resolveId(value);
  }

  // copies an op, resolving the handles in its top-level values; the caller's object is not changed.
  function resolveOp(op) {
    const resolved = {};
    for (const key of Object.keys(op)) {
      resolved[key] = resolveValue(op[key]);
    }
    return resolved;
  }

  function pageKey(fileId, pageId) {
    return JSON.stringify([fileId, pageId]);
  }

  // working copy of one page

  function PageModel(fileId, pageId) {
    this.fileId = fileId;
    this.pageId = pageId;
    this.revn = null;
    this.records = new Map();
  }

  PageModel.prototype.get = function (id) {
    return this.records.get(resolveId(id));
  };

  PageModel.prototype.has = function (id) {
    return this.records.has(resolveId(id));
  };

  PageModel.prototype.root = function () {
    return this.get(ROOT_ID);
  };

  PageModel.prototype.children = function (id) {
    const record = this.get(id);
    const out = [];
    if (record && Array.isArray(record.shapes)) {
      for (const childId of record.shapes) {
        const child = this.get(childId);
        if (child) {
          out.push(child);
        }
      }
    }
    return out;
  };

  PageModel.prototype.parentOf = function (id) {
    const record = this.get(id);
    return record ? this.get(record.parentId) : undefined;
  };

  // every record in document order: the tree from the root first, then records outside the tree.
  PageModel.prototype.list = function () {
    const out = [];
    const seen = new Set();
    const visit = (id) => {
      const record = this.get(id);
      if (!record || seen.has(record.id)) {
        return;
      }
      seen.add(record.id);
      out.push(record);
      for (const childId of Array.isArray(record.shapes) ? record.shapes : []) {
        visit(childId);
      }
    };
    visit(ROOT_ID);
    for (const record of this.records.values()) {
      if (!seen.has(record.id)) {
        out.push(record);
      }
    }
    return out;
  };

  // reads one page from the host and replaces the records of the model with it.
  function loadRecords(model) {
    if (state.pageLoads >= MAX_PAGE_LOADS) {
      throw new Error(PAGE_LIMIT_MESSAGE);
    }
    state.pageLoads += 1;
    const data = JSON.parse(__host.loadPage(model.fileId, model.pageId));
    model.revn = data.revn;
    model.records = new Map();
    for (const shape of Array.isArray(data.shapes) ? data.shapes : []) {
      model.records.set(shape.id, shape);
    }
    state.revn = data.revn;
  }

  // returns the page model, loading it on first access; queued ops of the page are applied to a new load.
  function page(fileId, pageId) {
    const file = fileId === undefined ? state.fileId : resolveId(fileId);
    const pid = resolveId(pageId);
    const key = pageKey(file, pid);
    if (state.pages.has(key)) {
      return state.pages.get(key);
    }
    const model = new PageModel(file, pid);
    loadRecords(model);
    replayPending(model);
    state.pages.set(key, model);
    return model;
  }

  // a page loaded after some ops were queued must show those ops, because nothing was sent yet.
  function replayPending(model) {
    if (model.fileId !== state.fileId) {
      return;
    }
    for (const op of state.pending) {
      if (op.pageId === model.pageId) {
        applyLocal(model, op);
      }
    }
  }

  // reloads a page into its cached model, or into a new model when the page is not cached.
  function reloadPage(fileId, pageId) {
    const key = pageKey(fileId, pageId);
    if (state.pageLoads >= MAX_PAGE_LOADS) {
      state.pages.delete(key);
      return;
    }
    const model = state.pages.get(key) || new PageModel(fileId, pageId);
    loadRecords(model);
    state.pages.set(key, model);
  }

  // local effects of queued ops (best effort, for read-after-write within one call)

  function frameOf(record) {
    return record.type === "frame" ? record.id : record.frameId;
  }

  function insertChild(parent, id, index) {
    if (!Array.isArray(parent.shapes)) {
      parent.shapes = [];
    }
    const end = parent.shapes.length;
    const at = typeof index === "number" && index >= 0 && index < end ? index : end;
    parent.shapes.splice(at, 0, id);
  }

  // removes a record from the child list of its parent, if the parent is known.
  function detachChild(model, record) {
    const parent = model.get(record.parentId);
    if (parent && Array.isArray(parent.shapes)) {
      const at = parent.shapes.indexOf(record.id);
      if (at >= 0) {
        parent.shapes.splice(at, 1);
      }
    }
  }

  // true when ancestorId is id itself or one of its ancestors.
  function isWithin(model, ancestorId, id) {
    const seen = new Set();
    let current = model.get(id);
    while (current && !seen.has(current.id)) {
      if (current.id === ancestorId) {
        return true;
      }
      seen.add(current.id);
      current = model.get(current.parentId);
    }
    return false;
  }

  // sets the frame of a record and of its descendants; a frame starts a new frame for its children.
  function reframe(model, record, frameId, seen) {
    if (seen.has(record.id)) {
      return;
    }
    seen.add(record.id);
    record.frameId = frameId;
    const innerFrameId = record.type === "frame" ? record.id : frameId;
    for (const child of model.children(record.id)) {
      reframe(model, child, innerFrameId, seen);
    }
  }

  function createLocal(model, op, type) {
    const parentId = op.parentId === undefined ? ROOT_ID : op.parentId;
    const parent = model.get(parentId);
    const record = {
      id: op.id,
      type: type,
      name: op.name === undefined ? DEFAULT_NAMES[type] : op.name,
      parentId: parentId,
      frameId: parent ? frameOf(parent) : ROOT_ID,
      shapes: [],
      x: op.x,
      y: op.y,
      width: op.width,
      height: op.height
    };
    if (op.props && typeof op.props === "object") {
      Object.assign(record, op.props);
    }
    if (!Array.isArray(record.shapes)) {
      record.shapes = [];
    }
    model.records.set(record.id, record);
    if (parent) {
      insertChild(parent, record.id, op.index);
    }
    return record;
  }

  function updateLocal(model, op) {
    const record = model.get(op.id);
    if (!record || !op.props || typeof op.props !== "object") {
      return;
    }
    // merging the props also updates x, y, width, height and rotation.
    Object.assign(record, op.props);
  }

  function moveLocal(model, op) {
    const target = model.get(op.parentId);
    if (!target) {
      return;
    }
    const moved = [];
    for (const id of op.ids) {
      const record = model.get(id);
      if (!record || record.id === target.id || isWithin(model, record.id, target.id)) {
        continue;
      }
      if (moved.indexOf(record) >= 0) {
        continue;
      }
      detachChild(model, record);
      moved.push(record);
    }
    if (!Array.isArray(target.shapes)) {
      target.shapes = [];
    }
    let at = typeof op.index === "number" && op.index >= 0 && op.index < target.shapes.length
      ? op.index
      : target.shapes.length;
    for (const record of moved) {
      target.shapes.splice(at, 0, record.id);
      at += 1;
      record.parentId = target.id;
    }
    const frameId = frameOf(target);
    const seen = new Set();
    for (const record of moved) {
      reframe(model, record, frameId, seen);
    }
  }

  function reorderLocal(model, op) {
    const parent = model.get(op.parentId);
    if (!parent) {
      return;
    }
    const shapes = [];
    for (const id of op.ids) {
      const record = model.get(id);
      if (record) {
        shapes.push(record.id);
      }
    }
    parent.shapes = shapes;
  }

  function removeTree(model, record, seen) {
    if (seen.has(record.id)) {
      return;
    }
    seen.add(record.id);
    model.records.delete(record.id);
    for (const childId of Array.isArray(record.shapes) ? record.shapes : []) {
      const child = model.get(childId);
      if (child) {
        removeTree(model, child, seen);
      }
    }
  }

  function deleteLocal(model, op) {
    const seen = new Set();
    for (const id of op.ids) {
      const record = model.get(id);
      if (!record) {
        continue;
      }
      detachChild(model, record);
      removeTree(model, record, seen);
    }
  }

  // builds a group or a boolean around the children, which take the place of the first child.
  function groupLocal(model, op, type) {
    const children = [];
    for (const id of Array.isArray(op.childIds) ? op.childIds : []) {
      const record = model.get(id);
      if (record && record.id !== ROOT_ID && children.indexOf(record) < 0) {
        children.push(record);
      }
    }
    if (children.length === 0) {
      return;
    }
    const first = children[0];
    const parent = model.get(first.parentId);
    if (!parent) {
      return;
    }
    if (!Array.isArray(parent.shapes)) {
      parent.shapes = [];
    }
    const childIds = children.map((record) => record.id);
    const childSet = new Set(childIds);
    const at = parent.shapes.indexOf(first.id);
    // the group goes where the first child is, counting only the siblings that stay in place before it.
    const insertAt = at < 0
      ? parent.shapes.length
      : parent.shapes.slice(0, at).filter((id) => !childSet.has(id)).length;

    const bounds = geometryOf(children);
    const group = {
      id: op.id,
      type: type,
      name: op.name === undefined ? DEFAULT_NAMES[type] : op.name,
      parentId: parent.id,
      frameId: frameOf(parent),
      shapes: childIds.slice(),
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height
    };
    if (type === "bool") {
      group.boolType = op.boolType;
    }
    for (const record of children) {
      detachChild(model, record);
    }
    parent.shapes.splice(insertAt, 0, group.id);
    model.records.set(group.id, group);
    const frameId = frameOf(group);
    const seen = new Set();
    for (const record of children) {
      record.parentId = group.id;
      reframe(model, record, frameId, seen);
    }
  }

  // bounding box of records, with missing numbers counted as zero.
  function geometryOf(records) {
    const finite = (value) => (typeof value === "number" && isFinite(value) ? value : 0);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const record of records) {
      const x = finite(record.x);
      const y = finite(record.y);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + finite(record.width));
      maxY = Math.max(maxY, y + finite(record.height));
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  // applies one queued op to a page model. Ops without a local effect are skipped; the next flush reloads.
  function applyLocal(model, op) {
    switch (op.op) {
      case "create_board":
        createLocal(model, op, "frame");
        break;
      case "create_rect":
        createLocal(model, op, "rect");
        break;
      case "create_ellipse":
        createLocal(model, op, "circle");
        break;
      case "create_text":
        createLocal(model, op, "text");
        break;
      case "create_path":
        createLocal(model, op, "path");
        break;
      case "create_image":
        createLocal(model, op, "image");
        break;
      case "create_svg_raw":
        createLocal(model, op, "svg-raw");
        break;
      case "create_group":
        groupLocal(model, op, "group");
        break;
      case "create_boolean":
        groupLocal(model, op, "bool");
        break;
      case "update_shape":
        updateLocal(model, op);
        break;
      case "move_shapes":
        moveLocal(model, op);
        break;
      case "reorder":
        reorderLocal(model, op);
        break;
      case "delete_shapes":
        deleteLocal(model, op);
        break;
      default:
        break;
    }
  }

  // folding: an op that changes a shape created in the same batch goes into the create op of that shape. The
  // batch then has the same effect as the ops in order, because an op folds only when no op queued after the
  // create names the shape, or the new parent, before it:
  // - an update_shape with only foldable props goes onto the create of its shape, until a move folded into it;
  // - a move_shapes of one shape, without an index, gives the create its parent, when the create has no parent
  //   yet and the parent is an existing id or a handle created before the create. The children of a parent
  //   then keep the order of their moves.
  // Only board, rectangle and ellipse creates take folds: text, path and image creates derive their attributes
  // from the create, so an update of them stays a separate op. A key whose value is undefined counts as absent,
  // as it does in the JSON that the host receives.

  const FOLDABLE_CREATE_OPS = new Set(["create_board", "create_rect", "create_ellipse"]);
  const FOLDABLE_UPDATE_KEYS = new Set(["op", "pageId", "id", "props"]);
  const FOLDABLE_MOVE_KEYS = new Set(["op", "pageId", "ids", "parentId"]);
  // geometry and name are fields of a create; the other props are attributes that a create takes as props
  const FOLDABLE_PROPS = new Set([
    "x", "y", "width", "height", "name", "fills", "strokes", "opacity", "hidden", "blocked", "blendMode"
  ]);
  const CREATE_FIELDS = new Set(["x", "y", "width", "height", "name"]);

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function definedKeys(value) {
    return Object.keys(value).filter((key) => value[key] !== undefined);
  }

  function hasOnlyKeys(value, keys) {
    return definedKeys(value).every((key) => keys.has(key));
  }

  function containsHandle(value) {
    if (typeof value === "string") {
      return isHandle(value);
    }
    if (Array.isArray(value)) {
      return value.some((item) => containsHandle(item));
    }
    if (isPlainObject(value)) {
      return Object.keys(value).some((key) => containsHandle(value[key]));
    }
    return false;
  }

  // true when every prop of an update can move onto a create and none names a handle.
  function isFoldableProps(value) {
    if (!isPlainObject(value)) {
      return false;
    }
    const keys = definedKeys(value);
    return keys.length > 0 && keys.every((key) => FOLDABLE_PROPS.has(key)) && !containsHandle(value);
  }

  // sets the props of an update on the create of the same shape; the props object of the create is copied first.
  function mergeProps(create, props) {
    for (const key of definedKeys(props)) {
      if (CREATE_FIELDS.has(key)) {
        create[key] = props[key];
      } else {
        const current = isPlainObject(create.props) ? Object.assign({}, create.props) : {};
        current[key] = props[key];
        create.props = current;
      }
    }
  }

  // what the folds of one batch need to know about the ops queued so far
  function FoldIndex() {
    // index in the batch of the create op of each shape id
    this.creates = new Map();
    // index in the batch of the last op that names each string
    this.lastNamed = new Map();
    // shapes whose create took a parent by a folded move; no later update folds into them
    this.sealed = new Set();
  }

  FoldIndex.prototype.namedAt = function (id) {
    const at = this.lastNamed.get(id);
    return at === undefined ? -1 : at;
  };

  FoldIndex.prototype.noteNames = function (value, index) {
    if (typeof value === "string") {
      this.lastNamed.set(value, Math.max(this.namedAt(value), index));
    } else if (Array.isArray(value)) {
      for (const item of value) {
        this.noteNames(item, index);
      }
    } else if (isPlainObject(value)) {
      for (const key of Object.keys(value)) {
        this.noteNames(value[key], index);
      }
    }
  };

  // records an op that the batch keeps at the given index.
  FoldIndex.prototype.noteKept = function (op, index) {
    this.noteNames(op, index);
    if (FOLDABLE_CREATE_OPS.has(op.op) && typeof op.id === "string") {
      this.creates.set(op.id, index);
    }
  };

  // folds an op into an earlier create of the batch; returns false when the op stays.
  FoldIndex.prototype.fold = function (batch, op) {
    return this.foldUpdate(batch, op) || this.foldMove(batch, op);
  };

  FoldIndex.prototype.foldUpdate = function (batch, op) {
    if (op.op !== "update_shape" || !hasOnlyKeys(op, FOLDABLE_UPDATE_KEYS)) {
      return false;
    }
    const id = op.id;
    if (typeof id !== "string" || this.sealed.has(id) || !isFoldableProps(op.props)) {
      return false;
    }
    const at = this.creates.get(id);
    if (at === undefined || batch[at].pageId !== op.pageId || this.namedAt(id) !== at) {
      return false;
    }
    mergeProps(batch[at], op.props);
    this.noteNames(op.props, at);
    return true;
  };

  FoldIndex.prototype.foldMove = function (batch, op) {
    if (op.op !== "move_shapes" || !hasOnlyKeys(op, FOLDABLE_MOVE_KEYS)) {
      return false;
    }
    const ids = op.ids;
    const parent = op.parentId;
    if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== "string" || typeof parent !== "string") {
      return false;
    }
    const child = ids[0];
    const at = this.creates.get(child);
    if (at === undefined || this.sealed.has(child) || parent === child || parent === ROOT_ID) {
      return false;
    }
    const create = batch[at];
    if (create.pageId !== op.pageId || (create.parentId !== ROOT_ID && create.parentId !== undefined)) {
      return false;
    }
    if (this.namedAt(child) !== at || !this.parentReadyAt(parent, at) || this.namedAt(parent) >= at) {
      return false;
    }
    create.parentId = parent;
    this.noteNames(parent, at);
    this.sealed.add(child);
    return true;
  };

  // true when a parent exists before the op at index at: an existing id, or a handle created before it.
  FoldIndex.prototype.parentReadyAt = function (parent, at) {
    if (!isHandle(parent)) {
      return true;
    }
    const created = this.creates.get(parent);
    return created !== undefined && created < at;
  };

  // queueing

  // empties the batch after it was sent, or dropped by a failed write.
  function clearPending() {
    state.pending = [];
    state.folds = new FoldIndex();
  }

  function enqueue(op) {
    if (op === null || typeof op !== "object") {
      throw new Error("execute_code operations must be objects");
    }
    const queued = resolveOp(op);
    const createsShape = ID_CREATE_OPS.has(queued.op);
    if (createsShape && !queued.id) {
      queued.id = handle("s");
    }
    if (!state.folds.fold(state.pending, queued)) {
      if (state.opCount >= MAX_OPERATIONS) {
        throw new Error(OPERATION_LIMIT_MESSAGE);
      }
      state.opCount += 1;
      state.folds.noteKept(queued, state.pending.length);
      state.pending.push(queued);
    }
    if (queued.pageId !== undefined) {
      const model = state.pages.get(pageKey(state.fileId, queued.pageId));
      if (model) {
        applyLocal(model, queued);
      }
    }
    return createsShape ? queued.id : undefined;
  }

  function touchedPageIds(ops) {
    const ids = [];
    for (const op of ops) {
      if (op.pageId !== undefined && ids.indexOf(op.pageId) < 0) {
        ids.push(op.pageId);
      }
    }
    return ids;
  }

  // after a flush, reloads each touched page, except the pages the batch deleted.
  function reloadTouched(fileId, ops) {
    const deleted = new Set();
    for (const op of ops) {
      if (op.op === "delete_page") {
        deleted.add(resolveId(op.id));
      }
    }
    for (const raw of touchedPageIds(ops)) {
      const pageId = resolveId(raw);
      if (isHandle(pageId)) {
        continue;
      }
      if (deleted.has(pageId)) {
        state.pages.delete(pageKey(fileId, pageId));
      } else {
        reloadPage(fileId, pageId);
      }
    }
  }

  function flush(dryRun) {
    if (state.pending.length === 0) {
      return { skipped: true };
    }
    const fileId = state.fileId;
    const ops = state.pending;
    let result;
    try {
      result = JSON.parse(__host.flush(fileId, JSON.stringify(ops), !!dryRun));
    } catch (err) {
      // a dry run changes nothing, so its ops stay pending; a failed write drops them and rereads the touched pages.
      if (!dryRun) {
        clearPending();
        for (const raw of touchedPageIds(ops)) {
          state.pages.delete(pageKey(fileId, raw));
        }
      }
      throw err;
    }
    if (dryRun) {
      return result;
    }
    clearPending();
    const created = result && result.createdIds ? result.createdIds : {};
    for (const key of Object.keys(created)) {
      state.aliases.set(key, created[key]);
    }
    if (result && typeof result.revn === "number") {
      state.revn = result.revn;
    }
    if (result && Array.isArray(result.warnings)) {
      state.warnings.push(...result.warnings);
    }
    reloadTouched(fileId, ops);
    return result;
  }

  function end() {
    flush(false);
  }

  function setFile(fileId) {
    flush(false);
    state.fileId = fileId;
  }

  // files, host calls and summary

  function fileOutline(fileId) {
    const id = fileId === undefined ? state.fileId : fileId;
    if (!state.files.has(id)) {
      state.files.set(id, JSON.parse(__host.loadFileOutline(id)));
    }
    return state.files.get(id);
  }

  function rpc(name, params) {
    return JSON.parse(__host.rpc(name, JSON.stringify(params || {})));
  }

  function importSvg(params) {
    flush(false);
    const request = params || {};
    const result = JSON.parse(__host.importSvg(JSON.stringify(request)));
    if (result && typeof result.revn === "number") {
      state.revn = result.revn;
    }
    // the import changes the page, so a cached copy of it is read again.
    const fileId = request.fileId === undefined ? state.fileId : request.fileId;
    if (state.pages.has(pageKey(fileId, request.pageId))) {
      reloadPage(fileId, request.pageId);
    }
    return result;
  }

  // flushes the queued writes when one of them changes tokens, so that a token read or apply sees them.
  function flushTokens() {
    if (state.pending.some((op) => TOKEN_WRITE_PATTERN.test(String(op.op)))) {
      flush(false);
    }
  }

  // renders a shape or downloads a fill image, through the host, and returns { mimeType, base64 }.
  function exportShape(params) {
    return JSON.parse(__host.exportShape(JSON.stringify(params || {})));
  }

  // stores an image from a URL in the media library, and returns the media object.
  function uploadMediaUrl(params) {
    return JSON.parse(__host.uploadMediaUrl(JSON.stringify(params || {})));
  }

  // stores image bytes, given as base64 text, in the media library, and returns the media object.
  function uploadMediaData(params) {
    return JSON.parse(__host.uploadMediaData(JSON.stringify(params || {})));
  }

  function summary() {
    return {
      opCount: state.opCount,
      revn: state.revn,
      warnings: state.warnings.slice()
    };
  }

  // errors and the runner

  function errorName(err) {
    return err && err.name ? String(err.name) : "Error";
  }

  function errorMessage(err) {
    return String((err && err.message) || err);
  }

  function errorStack(err) {
    return err && err.stack ? String(err.stack) : null;
  }

  function takeLog() {
    const text = logText;
    logText = "";
    return text;
  }

  // compiles the user code as the body of a plain function; a syntax error gets the await hint when relevant.
  function compileUserCode(code) {
    const text = String(code);
    try {
      return (0, eval)("(function () {\n" + text + "\n})");
    } catch (err) {
      if (AWAIT_PATTERN.test(text)) {
        const hinted = new Error(errorMessage(err) + ". " + AWAIT_HINT);
        hinted.name = errorName(err);
        throw hinted;
      }
      throw err;
    }
  }

  // JSON text of a result value; values that cannot be serialized fall back to their string form.
  function serializeValue(value) {
    if (value === undefined) {
      return "null";
    }
    try {
      const text = JSON.stringify(value);
      return text === undefined ? "null" : text;
    } catch (err) {
      return JSON.stringify(String(value));
    }
  }

  function successEnvelope(value) {
    const resultText = serializeValue(value);
    return '{"ok":true,"result":' + resultText +
      ',"undefinedResult":' + (value === undefined ? "true" : "false") +
      ',"log":' + JSON.stringify(takeLog()) + "}";
  }

  function failureEnvelope(err) {
    try {
      return JSON.stringify({
        ok: false,
        error: { name: errorName(err), message: errorMessage(err), stack: errorStack(err) },
        log: takeLog()
      });
    } catch (ignored) {
      return '{"ok":false,"error":{"name":"Error","message":"execute_code failed","stack":null},"log":""}';
    }
  }

  // runs one script and returns its envelope as JSON text. It never throws.
  function runScript(code, fileId, pageId) {
    try {
      beginCall(fileId, pageId);
      const fn = compileUserCode(code);
      const value = fn();
      end();
      return successEnvelope(value);
    } catch (err) {
      return failureEnvelope(err);
    }
  }

  // console capture, with the same line format as the bridge console

  function formatArgument(value) {
    if (value instanceof Error) {
      return String(value);
    }
    if (typeof value === "object") {
      try {
        const text = JSON.stringify(value, null, 2);
        return text === undefined ? String(value) : text;
      } catch (err) {
        return String(value);
      }
    }
    return String(value);
  }

  function emit(level, args) {
    const parts = [];
    for (const arg of args) {
      parts.push(formatArgument(arg));
    }
    logText += "[" + level + "] " + parts.join(" ") + "\n";
  }

  const consoleObject = {
    log: (...args) => emit("LOG", args),
    info: (...args) => emit("INFO", args),
    debug: (...args) => emit("DEBUG", args),
    trace: (...args) => emit("TRACE", args),
    warn: (...args) => emit("WARN", args),
    error: (...args) => emit("ERROR", args),
    table: (data) => emit("TABLE", [data]),
    time: (label) => emit("TIME", ["Timer started: " + (label || "default")]),
    timeEnd: (label) => emit("TIME_END", ["Timer ended: " + (label || "default")]),
    group: (label) => emit("GROUP", [label || ""]),
    groupCollapsed: (label) => emit("GROUP_COLLAPSED", [label || ""]),
    groupEnd: () => emit("GROUP_END", [""]),
    clear: () => {},
    count: (label) => emit("COUNT", [label || "default"]),
    countReset: (label) => emit("COUNT_RESET", [label || "default"]),
    assert: (condition, ...args) => {
      if (!condition) {
        emit("ASSERT", args);
      }
    }
  };

  const core = {
    begin: beginCall,
    fileId: () => state.fileId,
    pageId: () => state.pageId,
    file: fileOutline,
    page: page,
    handle: handle,
    resolve: resolveId,
    enqueue: enqueue,
    flush: flush,
    end: end,
    setFile: setFile,
    rpc: rpc,
    importSvg: importSvg,
    flushTokens: flushTokens,
    exportShape: exportShape,
    uploadMediaUrl: uploadMediaUrl,
    uploadMediaData: uploadMediaData,
    summary: summary,
    takeLog: takeLog
  };

  global.__core = core;
  global.__runScript = runScript;
  global.__drainLog = takeLog;
  global.console = consoleObject;
  global.storage = {};
})(globalThis);
`;
