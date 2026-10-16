// System Check — measures how much of a Figma selection uses design-system tokens.
// Colours: a solid fill or stroke counts as "linked" if it is bound to a colour variable
// or comes from a colour style. Text: a text layer counts as "linked" if it uses a text style.

figma.showUI(__html__, { width: 360, height: 560, themeColors: true });

// ---------- helpers ----------

function toHex(color) {
  const part = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
  return ("#" + part(color.r) + part(color.g) + part(color.b)).toUpperCase();
}

function distance(a, b) {
  const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db) * 255;
}

function hasStyle(styleId) {
  return typeof styleId === "string" && styleId !== "";
}

// Load every local colour variable once, with its resolved colour and collection name.
async function loadColorVariables() {
  const variables = await figma.variables.getLocalVariablesAsync("COLOR");
  const result = [];
  for (const variable of variables) {
    const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
    if (!collection) continue;
    let value = variable.valuesByMode[collection.defaultModeId];
    // Follow one level of aliasing (a variable that points at another variable).
    if (value && value.type === "VARIABLE_ALIAS") {
      const target = await figma.variables.getVariableByIdAsync(value.id);
      if (!target) continue;
      const targetCollection = await figma.variables.getVariableCollectionByIdAsync(target.variableCollectionId);
      value = targetCollection ? target.valuesByMode[targetCollection.defaultModeId] : null;
    }
    if (!value || typeof value.r !== "number") continue;
    result.push({
      id: variable.id,
      label: collection.name + " / " + variable.name,
      collection: collection.name,
      color: value,
    });
  }
  return result;
}

// Visit the selected layers and everything inside them, skipping hidden layers.
function walk(nodes, visit) {
  for (const node of nodes) {
    if (node.visible === false) continue;
    visit(node);
    if ("children" in node) walk(node.children, visit);
  }
}

// ---------- scan ----------

async function scan() {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    figma.ui.postMessage({ type: "error", message: "Select a frame or screen first, then press Scan." });
    return;
  }

  const variables = await loadColorVariables();
  const colorTotals = { linked: 0, total: 0 };
  const textTotals = { linked: 0, total: 0 };
  const unstyledText = [];
  const hardCoded = {}; // hex -> { hex, count, nodeIds:Set }
  const collectionsUsed = {}; // collection name -> count, used to break ties when suggesting

  const variableById = {};
  for (const v of variables) variableById[v.id] = v;

  walk(selection, (node) => {
    for (const prop of ["fills", "strokes"]) {
      if (!(prop in node)) continue;
      const paints = node[prop];
      if (!Array.isArray(paints)) continue; // figma.mixed on text with mixed colours
      const styleId = prop === "fills" ? node.fillStyleId : node.strokeStyleId;
      for (const paint of paints) {
        if (paint.type !== "SOLID" || paint.visible === false) continue;
        colorTotals.total += 1;
        const bound = paint.boundVariables && paint.boundVariables.color;
        if (bound || hasStyle(styleId)) {
          colorTotals.linked += 1;
          if (bound && variableById[bound.id]) {
            const name = variableById[bound.id].collection;
            collectionsUsed[name] = (collectionsUsed[name] || 0) + 1;
          }
          continue;
        }
        const hex = toHex(paint.color);
        if (!hardCoded[hex]) hardCoded[hex] = { hex, color: paint.color, count: 0, nodeIds: new Set() };
        hardCoded[hex].count += 1;
        hardCoded[hex].nodeIds.add(node.id);
      }
    }
    if (node.type === "TEXT") {
      textTotals.total += 1;
      if (hasStyle(node.textStyleId)) textTotals.linked += 1;
      else unstyledText.push(node.id);
    }
  });

  // The collection this selection mostly uses (e.g. "Dark" on a dark screen) wins ties.
  const preferred = Object.keys(collectionsUsed).sort((a, b) => collectionsUsed[b] - collectionsUsed[a])[0];

  const issues = Object.values(hardCoded)
    .sort((a, b) => b.count - a.count)
    .map((item) => {
      let best = null;
      for (const v of variables) {
        const d = distance(item.color, v.color);
        const better = !best || d < best.d - 0.5 || (Math.abs(d - best.d) <= 0.5 && v.collection === preferred);
        if (better) best = { d, v };
      }
      return {
        hex: item.hex,
        count: item.count,
        nodeIds: Array.from(item.nodeIds),
        suggestion: best ? { id: best.v.id, label: best.v.label, hex: toHex(best.v.color), exact: best.d < 1 } : null,
      };
    });

  const percent = (t) => (t.total === 0 ? 100 : Math.round((100 * t.linked) / t.total));
  figma.ui.postMessage({
    type: "results",
    colors: { linked: colorTotals.linked, total: colorTotals.total, percent: percent(colorTotals) },
    text: { linked: textTotals.linked, total: textTotals.total, percent: percent(textTotals) },
    issues,
    unstyledText,
    preferred: preferred || null,
  });
}

// ---------- actions ----------

async function selectNodes(nodeIds) {
  const nodes = [];
  for (const id of nodeIds) {
    const node = await figma.getNodeByIdAsync(id);
    if (node) nodes.push(node);
  }
  if (nodes.length === 0) return;
  figma.currentPage.selection = nodes;
  figma.viewport.scrollAndZoomIntoView(nodes);
}

// Replace every unlinked solid paint of this hex colour with the suggested variable.
async function fix(hex, nodeIds, variableId) {
  const variable = await figma.variables.getVariableByIdAsync(variableId);
  if (!variable) return;
  let changed = 0;
  for (const id of nodeIds) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node) continue;
    for (const prop of ["fills", "strokes"]) {
      if (!(prop in node) || !Array.isArray(node[prop])) continue;
      const styleId = prop === "fills" ? node.fillStyleId : node.strokeStyleId;
      if (hasStyle(styleId)) continue;
      let touched = false;
      const updated = node[prop].map((paint) => {
        const bound = paint.boundVariables && paint.boundVariables.color;
        if (paint.type === "SOLID" && !bound && toHex(paint.color) === hex) {
          touched = true;
          changed += 1;
          return figma.variables.setBoundVariableForPaint(paint, "color", variable);
        }
        return paint;
      });
      if (touched) node[prop] = updated;
    }
  }
  figma.notify("Linked " + changed + " colour" + (changed === 1 ? "" : "s") + " to " + variable.name);
}

figma.ui.onmessage = async (msg) => {
  try {
    if (msg.type === "scan") await scan();
    if (msg.type === "select") await selectNodes(msg.nodeIds);
    if (msg.type === "fix") {
      await fix(msg.hex, msg.nodeIds, msg.variableId);
      await scan();
    }
  } catch (err) {
    figma.ui.postMessage({ type: "error", message: String(err && err.message ? err.message : err) });
  }
};
