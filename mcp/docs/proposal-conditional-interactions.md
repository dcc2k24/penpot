# Design: conditional and variable-driven interactions

Status: proposal for a decision. Branch `perf/render-wasm-large-files`. Nothing here is built.

## The decision

The Kiosk journeys draw their decisions by hand: "is…?" frames between screens, with arrows to the two outcomes. The generated app needs flags (is the user an admin, is a key checked out, is logging on) to pick the next screen. Penpot interactions have no variables and no conditions, so these decisions cannot be prototype links (`mcp/docs/avalonia-test-run-improvements.md:58`, `:161`; `mcp/docs/avalonia-test-run-improvements-v2.md:42`).

Recommendation, in short: boolean variables stored on the page; a new action `:set-variable`; and an optional `:condition` on any interaction, with no `:else` field. "Else" is a second interaction on the same trigger with the opposite condition. This is a core product feature. Agree the naming, the data model and the Figma mapping upstream before writing code. Build nothing in the product on this branch.

## The current model

### Schema and helpers

`common/src/app/common/types/shape/interactions.cljc`:
- Event types: `:click`, `:mouse-press`, `:mouse-over`, `:mouse-enter`, `:mouse-leave`, `:after-delay` (`:31-37`).
- Action types: `:navigate`, `:open-overlay`, `:toggle-overlay`, `:close-overlay`, `:prev-screen`, `:open-url` (`:39-45`).
- One interaction is one event plus one action, flat in one map. `schema:interaction` is `[:and generic-attrs [:multi {:dispatch :action-type} ...]]` (`:182-198`). The maps are open, so an unknown key passes; an unknown action type does not.
- Animations are a `:multi` on `:animation-type` (`:101-110`).
- A shape holds `[:interactions [:vector schema:interaction]]` (`common/src/app/common/types/shape.cljc:225-226`).
- Helpers read `:destination` at the top level: `remap-interactions` (`interactions.cljc:773-787`), `flow-origin?`, `flow-to?` (`:799-811`), `navs-to?` (`:744-748`).

### Flows

A flow is `{:id :name :starting-frame}` in the page's `:flows` map (`common/src/app/common/types/page.cljc:25-32`, `:60`). The change `:set-flow` writes one (`common/src/app/common/files/changes.cljc:126-135`, `:566-578`).

### Workspace

- Options panel: `interaction-item*` edits one interaction (`frontend/src/app/main/ui/workspace/sidebar/options/menus/interactions.cljs:170-652`); `page-flows*` and `shape-flows*` list flows (`:654-706`).
- Events: `add-interaction`, `update-interaction`, `remove-interaction`, `remove-all-interactions-nav-to` (`frontend/src/app/main/data/workspace/interactions.cljs:146-249`). Adding one un-hides its destination in the viewer (`:157-158`).
- Arrows on the canvas: `frontend/src/app/main/ui/workspace/viewport/interactions.cljs:306-343`.

### Viewer run time

- Each shape's `g` carries pointer handlers (`frontend/src/app/main/ui/viewer/shapes.cljs:368-433`). `on-pointer-down` runs every `:click` and `:mouse-press` interaction of the shape, in vector order, with `doseq` (`shapes.cljs:227-235`). So several interactions on one trigger already run in order.
- `activate-interaction` maps each action to an event (`shapes.cljs:56-147`). `:navigate` emits `dv/go-to-frame` (`frontend/src/app/main/data/viewer.cljs:634-671`), which writes the board index into the URL. `:prev-screen` calls `rt/nav-back-local`, which is browser history back (`shapes.cljs:141-142`, `frontend/src/app/main/router.cljs:170-177`).
- `:after-delay` is scheduled on mount (`shapes.cljs:269-280`).
- Viewer state lives in `:viewer-local` and `:viewer`; `finalize` drops `:viewer` (`data/viewer.cljs:62-112`).

### Plugin API

`Action` is a union of six types (`plugins/libs/plugin-types/index.d.ts:148-154`); `Interaction` has `trigger`, `delay`, `action` (`:2737-2762`); `addInteraction(trigger, action, delay)` (`:4435`); `Trigger` (`:4895`); `Flow` (`:2137-2158`). The CLJS side: `format-action` (`frontend/src/app/plugins/format.cljs:530-574`), `parse-interaction` (`frontend/src/app/plugins/parser.cljs:534-540`), the interaction proxy and its validation (`frontend/src/app/plugins/shape.cljs:80-140`).

### MCP

- Writes: `add_interaction` takes an interaction map, decoded and checked against `ctsi/schema:interaction` (`common/src/app/common/mcp/operations/schema.cljc:310-311`, `:386-387`), then appended (`common/src/app/common/mcp/operations/prototype.cljc:62-86`, `:159-170`). `create_flow` and `remove_flow` (`prototype.cljc:88-111`).
- Reads: `get-mcp-interactions` returns each stored interaction as is, plus `destination-name` (`backend/src/app/rpc/commands/mcp_prototype.clj:1255-1270`, `:1331-1380`). `find-mcp-connectors` marks an end that lands on no screen, such as a decision frame, with `non-screen` (`mcp_prototype.clj:1140-1152`, `:1456`).
- JSON keys are camelCase on the wire and kebab-case inside (`mcp/docs/backend-mode-contract.md:10-12`).

### Validation, migrations, files

- `validate.cljc` checks referential integrity of shapes and components (`common/src/app/common/files/validate.cljc:29-69`). It has no interaction rule; interactions are checked only by the shape schema.
- Migrations: `legacy-7` drops interactions whose destination is gone (`common/src/app/common/files/migrations.cljc:254-262`); `0002-clean-shape-interactions` decodes every interaction and drops the invalid ones (`migrations.cljc:1272-1295`).
- Binfile v3 writes each page with `encode-page` over `ctp/schema:page` and each shape with `encode-shape` (`backend/src/app/binfile/v3.clj:119-123`, `:368-374`), and checks shapes on import (`v3.clj:204-205`). A new page key with a schema travels with no binfile change.
- The view-only bundle keeps only `[:id :options :pages :pages-index :components]` of file data (`backend/src/app/rpc/commands/viewer.clj:28-32`). A new file-level key would not reach the viewer; a page key would.
- There is no Figma importer in this repository (`git ls-files` finds only an image named `figma`).

## What the reported case needs

- **Variables.** A name, a type and a default. The Kiosk flags are all booleans. Numbers (a retry count, a cabinet slot) and strings are not needed for the reported journeys.
- **Where they live.** The viewer runs one page at a time, and a destination is always a board of the same page. Storing variables on the page matches the run-time scope, passes through the view-only bundle and binfile v3, and follows the `:set-flow` pattern. File-level variables (as in Figma) would need changes in `viewer.clj:32` and binfile, and a rule for which page sees which.
- **Run-time scope.** One prototype session: from opening the viewer, or starting a flow, until reload or restart.
- **A "set variable" action.**
- **A condition on an interaction.** When the event fires, the action runs only if the condition holds. An "else" runs the other outcome.

### Figma, for an importer

What I know, from Figma's plugin API typings; I have not checked them against current docs:
- Variables are file-level, in collections with modes, of type boolean, number, string or colour.
- A reaction has a trigger and a list of `actions`.
- `SET_VARIABLE` sets a variable to a value or an expression.
- `CONDITIONAL` holds `conditionalBlocks`; each has an optional condition and its own list of actions. The last block without a condition is the else.
- Conditions are expressions (equals, not, and, or, comparisons).

Not sure: whether a prototype resets variables on restart (I believe it does), and whether "back" restores values (I believe it does not).

## Candidate data models

Shared by all three: variables on the page, and a change that sets one.

```clojure
(def schema:prototype-variable
  [:map {:title "PrototypeVariable"}
   [:id ::sm/uuid]
   [:name :string]
   [:type [:= :boolean]]          ;; later: :number :string
   [:default :boolean]])

;; ctp/schema:page
[:variables {:optional true} [:map-of ::sm/uuid schema:prototype-variable]]

;; changes.cljc, the same shape as :set-flow
[:set-prototype-variable
 [:map [:type [:= :set-prototype-variable]] [:page-id ::sm/uuid] [:id ::sm/uuid]
  [:params [:maybe schema:prototype-variable]]]]

(def schema:condition                      ;; every clause must hold
  [:vector {:min 1}
   [:map [:variable ::sm/uuid] [:equals :boolean]]])

(def schema:set-variable-interaction
  [:map {:title "SetVariableInteraction"}
   [:action-type [:= :set-variable]]
   [:event-type [::sm/one-of event-types]]
   [:variable ::sm/uuid]
   [:value :boolean]])
```

### (a) A condition on the interaction, with an optional else

```clojure
;; schema:generic-interaction-attrs
[:condition {:optional true} schema:condition]
[:else {:optional true} schema:else-action]   ;; any action map, no event
```

- **Old files:** valid, no migration.
- **Validator:** unknown variable, `:set-variable` value not of the variable's type.
- **Cost:** every reader of `:destination` must also read `[:else :destination]`: `remap-interactions`, the delete cleanups in `common/src/app/common/logic/shapes.cljc:319`, `:451`, `remove-all-interactions-nav-to`, the canvas arrows, `flow-to?`, the SVG export metadata (`frontend/src/app/main/ui/shapes/export.cljs:353`), the plugin format, and the MCP `destination-name`.
- **JSON:** `{"eventType":"click","actionType":"navigate","destination":"A","condition":[...],"else":{"actionType":"navigate","destination":"B"}}`.

### (a') A condition on the interaction, else as a second interaction

As (a) without `:else`. "If admin go to A, else go to B" is two `:click` interactions on the same shape: one with `equals true`, one with `equals false`. An if, else-if, else chain over booleans maps the same way, since a condition is a list of clauses that must all hold.

- **Old files:** valid, no migration.
- **Readers of `:destination`:** unchanged, since each interaction still has one action at the top level. The arrows show both outcomes with no change.
- **Rule needed:** all conditions of one event are evaluated against the values at the moment of the event, before any action runs. Without it, "if on, set off; if off, set on" would set off and then on again.

### (b) A new action `:conditional` with branches

```clojure
[:action-type [:= :conditional]]
[:branches [:vector {:min 1}
            [:map [:condition {:optional true} schema:condition]
                  [:action schema:action]]]]   ;; action split out of the interaction
```

- **Fit:** closest to Figma's `CONDITIONAL`.
- **Cost:** the action must be split from the event in the schema, and every reader of `:destination` must walk the branches.
- **Old clients:** an older client fails `[::sm/one-of action-types]`, and migration `0002` would drop the interaction if it ran (it runs once per file, so only on old files).

### (c) A list of actions per interaction

`{:event-type :click :actions [{:action-type :set-variable ...} {:action-type :navigate ...}]}`, with a `:conditional` action as in (b).

- **Fit:** Figma's model one to one.
- **Cost:** a migration that rewraps every stored interaction, and changes in every reader, the plugin API (`Interaction.action` becomes a list) and the MCP. It is the largest change, and the one an upstream maintainer may want long term.

### For all models

- **Validator:** a new rule in `validate.cljc` for a condition or `:set-variable` that names a variable the page lacks, with a repair that drops the condition. Type mismatch is covered by the schema while only booleans exist. There are no cycles, since defaults are literals and conditions read only variables.
- **Variable deletion:** deleting a variable must strip conditions and `:set-variable` actions that use it, as `remove-all-interactions-nav-to` does for deleted boards.
- **Copies across pages and files:** an interaction copied to another page, or a component instance from a library, can name a variable that does not exist there. Evaluate an unknown variable as false, and report it in the lint.
- **Old clients:** they ignore `:condition` and would run both outcomes. Gate the feature with a file feature (for example `"prototype/variables"`) in `supported-features` (`common/src/app/common/features.cljc:45-61`), so an older frontend refuses the file instead of running it wrong (`check-client-features!`, `features.cljc:186`).

## Run time in the viewer

- **State.** `:viewer-local :variables`, a map of variable id to value, seeded from the page defaults when the page loads.
- **Reset:** on `initialize`, on a page change, when a flow is picked in `flows-menu*` (`frontend/src/app/main/ui/viewer/interactions.cljs:211-218`), and on "go to first board". A reload resets too, since the state is not in the URL.
- **Evaluation.** `on-pointer-down` and its siblings emit one event, `dv/run-interactions`, with the shape's interactions for that trigger. The event reads the values once, filters by condition, then emits the actions in order. Doing this inside one potok event keeps the snapshot rule and the order. `:after-delay` evaluates when the timer fires.
- **Deactivation.** `:mouse-press` and `:mouse-over` undo their action on release (`shapes.cljs:150-225`). `:set-variable` has no undo; leave it out of `deactivate-interaction`.
- **Previous screen.** It is browser history back, and the values stay as they are. That matches what I believe Figma does; say so in the docs.
- **Inspect and comments.** Inspect does not run interactions, and shows the board as drawn. Comments mode renders the same viewport, so interactions and variables keep working there; the values carry over when the user switches section, since the session is the same.
- **Shared links.** A link that opens at a given `index` starts with the defaults.

## The editor, smallest usable UI

- **Prototype tab, no selection:** a "Variables" list under the flows (`page-flows*`), with name, a true or false default, add, rename and delete.
- **`interaction-item*`:**
  - a "Set variable" action with a variable select and a true or false value;
  - an optional "Only if" row: variable select plus "is true" or "is false";
  - a button "Add else" that adds a second interaction with the opposite condition, shown right below.
- **Canvas arrows:** dashed for a conditional interaction.

## Recommendation

Model (a'), with page variables, booleans only.

**First slice:**
- page variables;
- `:set-variable` with a literal value;
- `:condition` on any interaction;
- the snapshot rule;
- the file feature gate;
- the validator rule and the deletion cleanup;
- the viewer run time;
- the editor rows above;
- the plugin API fields;
- the MCP op `set_prototype_variable` plus `:condition` in `add_interaction`;
- the page's variables in `get_interactions`.

**Why (a').** It changes no reader of `:destination`, needs no migration, and maps Figma's boolean conditionals by expanding else-if chains into clause lists. It also migrates cleanly to (c) later: each interaction becomes a one-action list under a one-branch conditional.

**Worked example.** A start screen "Choose user" has two buttons, "Admin" and "Staff". Each sets `isAdmin` and goes to Login. On Login, the "Log in" button goes to "Main menu admin" if `isAdmin`, else to "Main menu".

```json
{"fileId": "F", "operations": [
  {"op": "set_prototype_variable", "pageId": "P", "id": "$tmp:isAdmin",
   "name": "isAdmin", "type": "boolean", "default": false},
  {"op": "add_interaction", "pageId": "P", "id": "BTN_ADMIN",
   "interaction": {"eventType": "click", "actionType": "set-variable",
                   "variable": "$tmp:isAdmin", "value": true}},
  {"op": "add_interaction", "pageId": "P", "id": "BTN_ADMIN",
   "interaction": {"eventType": "click", "actionType": "navigate", "destination": "LOGIN"}},
  {"op": "add_interaction", "pageId": "P", "id": "BTN_STAFF",
   "interaction": {"eventType": "click", "actionType": "set-variable",
                   "variable": "$tmp:isAdmin", "value": false}},
  {"op": "add_interaction", "pageId": "P", "id": "BTN_STAFF",
   "interaction": {"eventType": "click", "actionType": "navigate", "destination": "LOGIN"}},
  {"op": "add_interaction", "pageId": "P", "id": "BTN_LOGIN",
   "interaction": {"eventType": "click", "actionType": "navigate", "destination": "MAIN_MENU_ADMIN",
                   "condition": [{"variable": "$tmp:isAdmin", "equals": true}]}},
  {"op": "add_interaction", "pageId": "P", "id": "BTN_LOGIN",
   "interaction": {"eventType": "click", "actionType": "navigate", "destination": "MAIN_MENU",
                   "condition": [{"variable": "$tmp:isAdmin", "equals": false}]}}
]}
```

`set_prototype_variable` and the handle inside `condition` and `variable` are new. `add_interaction` today decodes the map with the schema only (`schema.cljc:386-387`), so its compile step must resolve handles in those two places.

**Left out:**
- number and string variables;
- expressions (not, and, or, arithmetic, toggles);
- file-level variables and modes;
- a panel in the viewer that shows the current values;
- "set variable" from a text input;
- conditional overlays beyond what the model already allows;
- the Figma importer (it is not in this repository).

## Size and risk by surface

| Surface | Files | Size | Main risk |
|---|---|---|---|
| Data model and validation | `interactions.cljc`, `page.cljc`, `changes.cljc`, `changes_builder.cljc`, `validate.cljc`, `features.cljc`, `logic/shapes.cljc` | Medium | The feature gate; repairs that drop data silently |
| Viewer | `data/viewer.cljs`, `ui/viewer/shapes.cljs`, `ui/viewer/interactions.cljs` | Medium | Event order and the snapshot rule; the reset points |
| Workspace editor | `menus/interactions.cljs` (788 lines already), `data/workspace/interactions.cljs`, `viewport/interactions.cljs`, new variables panel, `en.po` | Large | UI design upstream will want to own |
| Plugin API | `index.d.ts`, `plugins/format.cljs`, `plugins/parser.cljs`, `plugins/shape.cljs`, `plugins/page.cljs`, `api-surface.json` | Medium | A public API, hard to change later |
| MCP | `operations/prototype.cljc`, `operations/schema.cljc`, `mcp_prototype.clj`, the adapter facade (`mcp/packages/server/src/sandbox/facade/ApiSource.ts:2539`), `backend_instructions.md`, `backend-mode-contract.md` | Small to medium | Handle resolution inside interaction maps |
| Docs | `docs/user-guide/prototyping-testing/prototyping.njk` | Small | None |
| Tests | common schema, change and validator tests; viewer unit tests; a Playwright viewer spec with a fixture under `frontend/playwright/data/viewer/`; MCP op and read tests | Medium | None |

**Total: large.** A rough guess is four to six weeks for one engineer who knows these parts, not counting design review upstream.

## Upstream first

This changes the file format, the viewer, the editor and the public plugin API. Settle these with Penpot before any code:
- **Naming:** "variables" or "prototype variables"; the action and key names.
- **The data model:** (a') now and (c) later, or (c) at once. Figma's model is (c).
- **The scope:** page or file.
- **The file feature gate.**
- **The Figma mapping,** which their importer would carry.

What could be built on this branch without that agreement: nothing in the product. Anything there would be a private file format. On the MCP side, `find_connectors` already reports decision frames as `nonScreen` ends, and `get_interactions` and `lint_page` give the rest of what a generator reads. A shared convention in plugin data (`set_plugin_data` on a decision frame) would work for one generator. But it would become a second format to migrate once Penpot has the feature, so I would not add it.

## What a generator can do today

- **One flow per flag setting.** Links belong to shapes, not flows, so a screen whose links differ by flag must exist once per setting. The journeys already copy screens (Main Menu Admin six times, `avalonia-test-run-improvements-v2.md:28`), so this fits them in part, at the price of more copies.
- **Decision frames as data.** `find_connectors` marks an end on a decision frame `nonScreen`. A generator can treat a frame whose name starts with "is" as a branch, and read its two outgoing connectors as the true and false outcomes. In the re-test, 6 of 54 connectors touched decision frames, and the direction was wrong for many arrows (`avalonia-test-run-improvements-v2.md:87-96`). So this still needs a person to check.
- **Flags in the generated app.** These stay hand-written: the reviewed navigation map of the first run held the conditional branches (`avalonia-test-run-improvements.md:54`).

Waiting costs one review pass per new journey with decisions. Building costs a large feature that upstream must want.
