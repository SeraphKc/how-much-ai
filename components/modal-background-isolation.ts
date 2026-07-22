export interface IsolationNode {
  readonly parentElement: IsolationNode | null;
  readonly children: {
    readonly length: number;
    readonly [index: number]: IsolationNode;
  };
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export interface ModalLayerNode {
  readonly style: { zIndex: string };
}

// DOM order is not necessarily modal-open order. Reindex every surviving root so the logical top
// modal is also the visually top layer after reverse openings, closes, and reopenings.
export function syncModalStackLayers(stack: readonly ModalLayerNode[], baseZIndex = 50): void {
  stack.forEach((node, index) => {
    node.style.zIndex = String(baseZIndex + index);
  });
}

interface PreservedAttributes {
  ariaHidden: string | null;
  inert: string | null;
}

function backgroundSiblings(activeRoot: IsolationNode | null, boundary: IsolationNode | null): Set<IsolationNode> {
  const background = new Set<IsolationNode>();
  let branch = activeRoot;

  while (branch?.parentElement) {
    const parent = branch.parentElement;
    for (let index = 0; index < parent.children.length; index += 1) {
      const sibling = parent.children[index];
      if (sibling !== branch) background.add(sibling);
    }
    if (parent === boundary) break;
    branch = parent;
  }

  return background;
}

function restoreAttribute(node: IsolationNode, name: string, value: string | null): void {
  if (value === null) node.removeAttribute(name);
  else node.setAttribute(name, value);
}

// Keeps only the active modal's ancestor branch exposed to assistive technology and pointer/focus
// input. Attribute values are captured exactly once, so rapid top-modal changes never overwrite the
// page's pre-existing accessibility state with an intermediate modal state.
export class ModalBackgroundIsolation {
  private readonly isolated = new Map<IsolationNode, PreservedAttributes>();

  update(activeRoot: IsolationNode | null, boundary: IsolationNode | null = null): void {
    const next = backgroundSiblings(activeRoot, boundary);

    for (const [node, preserved] of this.isolated) {
      if (next.has(node)) continue;
      restoreAttribute(node, "aria-hidden", preserved.ariaHidden);
      restoreAttribute(node, "inert", preserved.inert);
      this.isolated.delete(node);
    }

    for (const node of next) {
      if (this.isolated.has(node)) continue;
      this.isolated.set(node, {
        ariaHidden: node.getAttribute("aria-hidden"),
        inert: node.getAttribute("inert"),
      });
      node.setAttribute("aria-hidden", "true");
      node.setAttribute("inert", "");
    }
  }

  clear(): void {
    this.update(null);
  }
}
