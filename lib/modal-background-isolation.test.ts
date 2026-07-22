import test from "node:test";
import assert from "node:assert/strict";
import {
  ModalBackgroundIsolation,
  syncModalStackLayers,
  type IsolationNode,
} from "../components/modal-background-isolation.ts";

class FakeNode implements IsolationNode {
  parentElement: FakeNode | null = null;
  readonly children: FakeNode[] = [];
  private readonly attributes = new Map<string, string>();

  append(...nodes: FakeNode[]): this {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
    return this;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

test("modal background isolation restores exact pre-existing attributes", () => {
  const body = new FakeNode();
  const app = new FakeNode();
  const outside = new FakeNode();
  const background = new FakeNode();
  const modal = new FakeNode();
  body.append(app, outside);
  app.append(background, modal);
  background.setAttribute("aria-hidden", "false");
  background.setAttribute("inert", "legacy");

  const isolation = new ModalBackgroundIsolation();
  isolation.update(modal, body);

  assert.equal(background.getAttribute("aria-hidden"), "true");
  assert.equal(background.getAttribute("inert"), "");
  assert.equal(outside.getAttribute("aria-hidden"), "true");
  assert.equal(outside.getAttribute("inert"), "");
  assert.equal(modal.getAttribute("aria-hidden"), null);

  isolation.clear();
  assert.equal(background.getAttribute("aria-hidden"), "false");
  assert.equal(background.getAttribute("inert"), "legacy");
  assert.equal(outside.getAttribute("aria-hidden"), null);
  assert.equal(outside.getAttribute("inert"), null);
});

test("rapid sibling and nested modal changes expose only the active branch", () => {
  const body = new FakeNode();
  const app = new FakeNode();
  const background = new FakeNode();
  const firstModal = new FakeNode();
  const secondModal = new FakeNode();
  const firstContent = new FakeNode();
  const nestedModal = new FakeNode();
  body.append(app);
  app.append(background, firstModal, secondModal);
  firstModal.append(firstContent, nestedModal);

  const isolation = new ModalBackgroundIsolation();
  isolation.update(firstModal, body);
  assert.equal(background.getAttribute("inert"), "");
  assert.equal(secondModal.getAttribute("inert"), "");
  assert.equal(firstModal.getAttribute("inert"), null);

  isolation.update(secondModal, body);
  assert.equal(firstModal.getAttribute("inert"), "");
  assert.equal(secondModal.getAttribute("inert"), null);

  isolation.update(nestedModal, body);
  assert.equal(firstModal.getAttribute("inert"), null);
  assert.equal(firstContent.getAttribute("inert"), "");
  assert.equal(nestedModal.getAttribute("inert"), null);

  isolation.update(firstModal, body);
  assert.equal(firstContent.getAttribute("inert"), null);
  assert.equal(secondModal.getAttribute("inert"), "");

  isolation.clear();
  for (const node of [background, firstModal, secondModal, firstContent, nestedModal]) {
    assert.equal(node.getAttribute("aria-hidden"), null);
    assert.equal(node.getAttribute("inert"), null);
  }
});

test("modal layers follow open order through reverse openings and reopenings", () => {
  const earlierInDom = { style: { zIndex: "" } };
  const laterInDom = { style: { zIndex: "" } };

  // The DOM-later modal opens first; the DOM-earlier modal must still paint above it when opened.
  const stack = [laterInDom, earlierInDom];
  syncModalStackLayers(stack);
  assert.equal(laterInDom.style.zIndex, "50");
  assert.equal(earlierInDom.style.zIndex, "51");

  // Closing and reopening the first modal must not leave equal/stale layers behind.
  stack.splice(1, 1);
  syncModalStackLayers(stack);
  stack.push(earlierInDom);
  syncModalStackLayers(stack);
  assert.equal(laterInDom.style.zIndex, "50");
  assert.equal(earlierInDom.style.zIndex, "51");
});
