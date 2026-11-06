/**
 * JavaScript of the penpotUtils helper object, evaluated after the API layer.
 *
 * The helpers port the walk, lookup and layout helpers of the bridge plugin's PenpotUtils class to the synchronous
 * facade. They read shapes and pages through the Plugin API members that the facade implements, so a walk sees the
 * working copy and the queued writes. The image helpers, the token helpers, the CSS generator and the variant helper
 * have no backend equivalent here. Each one throws with its reason and the typed tool to use instead.
 */
export const UTILS_SOURCE: string = String.raw`
(function (global) {
  "use strict";

  // the facade proxies have no has trap, so the in operator is always false for a shape. the helpers read the
  // members directly instead. a member that the facade refuses is read through tryRead.

  const NOT_AVAILABLE_TEXT = "not available in backend mode";

  // a function that throws the not-available error of one helper, with the alternative the error names.
  function notAvailable(name, reason) {
    return function () {
      throw new Error("penpotUtils." + name + " is not available in backend mode; " + reason);
    };
  }

  // reads a member that the facade may refuse, such as flex, grid and component. only the facade's not-available
  // errors are swallowed; any other error is passed on.
  function tryRead(read) {
    try {
      return read();
    } catch (err) {
      if (err && String(err.message).indexOf(NOT_AVAILABLE_TEXT) >= 0) {
        return undefined;
      }
      throw err;
    }
  }

  // shape structure

  // the overview of a shape: id, name, type, the layout and the component when the facade reports them, and the
  // children. the facade refuses the flex, grid and component reads today, so those keys are left out.
  function shapeStructure(shape, maxDepth) {
    let children = undefined;
    if (maxDepth === undefined || maxDepth > 0) {
      const kids = shape.children;
      if (kids) {
        children = kids.map(function (child) {
          return shapeStructure(child, maxDepth === undefined ? undefined : maxDepth - 1);
        });
      }
    }

    const result = { id: shape.id, name: shape.name, type: shape.type };

    // add layout information if present
    const flex = tryRead(function () {
      return shape.flex;
    });
    if (flex) {
      result.layout = { type: "flex", dir: flex.dir, rowGap: flex.rowGap, columnGap: flex.columnGap };
    } else {
      const grid = tryRead(function () {
        return shape.grid;
      });
      if (grid) {
        result.layout = {
          type: "grid",
          rows: grid.rows,
          columns: grid.columns,
          rowGap: grid.rowGap,
          columnGap: grid.columnGap
        };
      }
    }

    // add component instance information if present
    if (shape.isComponentInstance()) {
      result.componentInstance = {};
      const component = tryRead(function () {
        return shape.component();
      });
      if (component) {
        result.componentInstance.componentId = component.id;
        result.componentInstance.componentName = component.name;
        const mainInstance = component.mainInstance();
        if (mainInstance) {
          result.componentInstance.mainInstanceId = mainInstance.id;
        }
      }
    }

    // finally, add children (last for more readable nesting order)
    result.children = children;
    return result;
  }

  // finding shapes and pages

  /**
   * Finds every descendant of the root that matches the predicate. It never tests the starting shape itself. When no
   * root is given, the search covers the current page, the page that penpot.currentPage names, from its root frame.
   *
   * @param predicate function that takes a shape and returns true for a match
   * @param root optional shape to search under; null or undefined searches the current page
   * @returns the matching shapes in tree order
   */
  function findShapes(predicate, root) {
    const result = [];
    const walk = function (shape) {
      if (!shape) {
        return;
      }
      const kids = shape.children;
      if (kids) {
        for (const child of kids) {
          if (predicate(child)) {
            result.push(child);
          }
          walk(child);
        }
      }
    };

    if (root === null || root === undefined) {
      const page = penpot.currentPage;
      if (page) {
        walk(page.root);
      }
    } else {
      walk(root);
    }
    return result;
  }

  // finds the first shape that matches the predicate, in tree order. the starting shape is tested too. a null root
  // searches every page.
  function findShape(predicate, root) {
    const find = function (shape) {
      if (!shape) {
        return null;
      }
      if (predicate(shape)) {
        return shape;
      }
      const kids = shape.children;
      if (kids) {
        for (const child of kids) {
          const found = find(child);
          if (found) {
            return found;
          }
        }
      }
      return null;
    };

    if (root === null || root === undefined) {
      for (const page of penpot.currentFile.pages) {
        const found = find(page.root);
        if (found) {
          return found;
        }
      }
      return null;
    }
    return find(root);
  }

  function findShapeById(id) {
    return findShape(function (shape) {
      return shape.id === id;
    });
  }

  function findPage(predicate) {
    const page = penpot.currentFile.pages.find(predicate);
    return page || null;
  }

  function getPages() {
    return penpot.currentFile.pages.map(function (page) {
      return { id: page.id, name: page.name };
    });
  }

  function getPageById(id) {
    return findPage(function (page) {
      return page.id === id;
    });
  }

  function getPageByName(name) {
    return findPage(function (page) {
      return page.name.toLowerCase() === name.toLowerCase();
    });
  }

  // the first page that holds the shape, or null. every page is loaded to answer this.
  function getPageForShape(shape) {
    for (const page of penpot.currentFile.pages) {
      if (page.getShapeById(shape.id)) {
        return page;
      }
    }
    return null;
  }

  // geometry

  // the rendering bounds of a shape. text shapes use textBounds, because bounds may not match the rendered text.
  function getBounds(shape) {
    if (shape.type === "text") {
      return shape.textBounds;
    }
    return shape.bounds;
  }

  // true when every edge of the child lies within the bounds of the parent.
  function isContainedIn(child, parent) {
    const childBounds = getBounds(child);
    const parentBounds = getBounds(parent);
    return (
      childBounds.x >= parentBounds.x &&
      childBounds.y >= parentBounds.y &&
      childBounds.x + childBounds.width <= parentBounds.x + parentBounds.width &&
      childBounds.y + childBounds.height <= parentBounds.y + parentBounds.height
    );
  }

  // sets the position of a shape relative to its parent. parentX and parentY are read-only in the Plugin API, so
  // the absolute x and y are written here.
  function setParentXY(shape, parentX, parentY) {
    const parent = shape.parent;
    if (!parent) {
      throw new Error("Shape has no parent - cannot set parent-relative position");
    }
    shape.x = parent.x + parentX;
    shape.y = parent.y + parentY;
  }

  // layout

  // adds a flex layout to a container and keeps the visual order of its children. the children are sorted by x for
  // "row" and by y for "column", then each one moves to index 0 in that order. the facade does not return the layout
  // object, so this helper returns nothing.
  function addFlexLayout(container, dir) {
    const children = container.children || [];
    const sortedChildren = children.slice().sort(function (a, b) {
      return dir === "row" ? a.x - b.x : a.y - b.y;
    });

    container.addFlexLayout({ dir: dir });

    for (const child of sortedChildren) {
      child.setParentIndex(0);
    }
  }

  // analysis

  // calls the evaluator on every descendant of the root, and keeps each non-null result with its shape. the root
  // itself is not evaluated. a null or undefined result skips the descendant.
  function analyzeDescendants(root, evaluator, maxDepth) {
    const results = [];

    const traverse = function (shape, currentDepth) {
      const result = evaluator(root, shape);
      if (result !== null && result !== undefined) {
        results.push({ shape: shape, result: result });
      }

      if (maxDepth === undefined || currentDepth < maxDepth) {
        const kids = shape.children;
        if (kids) {
          for (const child of kids) {
            traverse(child, currentDepth + 1);
          }
        }
      }
    };

    const top = root.children;
    if (top) {
      for (const child of top) {
        traverse(child, 1);
      }
    }
    return results;
  }

  // images. The bytes come from the codec of the API layer, which has no atob or btoa.

  function base64ToByteArray(base64) {
    return __codec.decodeBase64(requireText(base64, "base64"));
  }

  // stores image bytes in the media library and places them as a rectangle filled with the image. The width and the
  // height keep the aspect ratio of the image when only one of them is given.
  function importImage(base64, mimeType, name, x, y, width, height) {
    const bytes = base64ToByteArray(base64);
    const imageData = penpot.uploadMediaData(name, bytes, mimeType);
    const rect = penpot.createRectangle();
    rect.name = name;

    const hasWidth = width !== undefined;
    const hasHeight = height !== undefined;
    let rectWidth;
    let rectHeight;
    if (hasWidth && hasHeight) {
      rectWidth = width;
      rectHeight = height;
    } else if (hasWidth) {
      rectWidth = width;
      rectHeight = rectWidth * (imageData.height / imageData.width);
    } else if (hasHeight) {
      rectHeight = height;
      rectWidth = rectHeight * (imageData.width / imageData.height);
    } else {
      rectWidth = imageData.width;
      rectHeight = imageData.height;
    }
    rect.resize(rectWidth, rectHeight);
    if (x !== undefined) {
      rect.x = x;
    }
    if (y !== undefined) {
      rect.y = y;
    }
    rect.fills = [{ fillOpacity: 1, fillImage: imageData }];
    return rect;
  }

  // the bytes of a shape rendered as a PNG or SVG ("shape"), or the stored image of its first image fill ("fill").
  function exportImage(shape, mode, asSVG) {
    if (mode === "shape") {
      return shape.export({ type: asSVG ? "svg" : "png" });
    }
    if (mode !== "fill") {
      throw new Error("Unsupported export mode: " + mode);
    }
    if (asSVG) {
      throw new Error("Image fills cannot be exported as SVG");
    }
    const fills = shape.fills;
    const fill = Array.isArray(fills)
      ? fills.find(function (candidate) {
          return candidate && candidate.fillImage;
        })
      : undefined;
    if (!fill) {
      throw new Error("No fill with image data found in the shape");
    }
    return __codec.exportFill(fill.fillImage.id);
  }

  // tokens. The helpers read the catalogue of the file through the facade.

  function findTokensByName(name) {
    const out = [];
    for (const set of penpot.library.local.tokens.sets) {
      for (const token of set.tokens) {
        if (token.name === name) {
          out.push(token);
        }
      }
    }
    return out;
  }

  function findTokenByName(name) {
    const found = findTokensByName(name);
    return found.length > 0 ? found[0] : null;
  }

  // the set that holds a token, or null when no set of the file holds it.
  function getTokenSet(token) {
    for (const set of penpot.library.local.tokens.sets) {
      if (set.tokens.some(function (candidate) {
        return candidate.id === token.id;
      })) {
        return set;
      }
    }
    return null;
  }

  // the token names of every set, grouped by set name and token type.
  function tokenOverview() {
    const overview = {};
    for (const set of penpot.library.local.tokens.sets) {
      const setOverview = {};
      for (const token of set.tokens) {
        if (!setOverview[token.type]) {
          setOverview[token.type] = [];
        }
        setOverview[token.type].push(token.name);
      }
      overview[set.name] = setOverview;
    }
    return overview;
  }

  function requireText(value, label) {
    if (typeof value !== "string") {
      throw new TypeError(label + " must be a string");
    }
    return value;
  }

  // the global object

  global.penpotUtils = {
    shapeStructure: shapeStructure,
    findShapes: findShapes,
    findShape: findShape,
    findShapeById: findShapeById,
    findPage: findPage,
    getPages: getPages,
    getPageById: getPageById,
    getPageByName: getPageByName,
    getPageForShape: getPageForShape,
    getBounds: getBounds,
    isContainedIn: isContainedIn,
    setParentXY: setParentXY,
    addFlexLayout: addFlexLayout,
    analyzeDescendants: analyzeDescendants,
    base64ToByteArray: base64ToByteArray,
    importImage: importImage,
    exportImage: exportImage,
    generateCss: notAvailable("generateCss", "code generation is not available in backend mode"),
    findTokensByName: findTokensByName,
    findTokenByName: findTokenByName,
    getTokenSet: getTokenSet,
    createVariantContainer: notAvailable("createVariantContainer", "variant ops are not in the facade yet"),
    tokenOverview: tokenOverview
  };
})(globalThis);
`;
