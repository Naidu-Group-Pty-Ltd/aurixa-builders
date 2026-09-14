import "@testing-library/jest-dom";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});

/*
  jsdom implements neither of these, and both are needed by primitives the
  product already ships: `cmdk` observes its list to size it, and Radix's
  popover-positioned surfaces measure the element they are anchored to. A
  component that uses one throws on mount here, which is indistinguishable
  from a component that is broken.
*/
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in window)) {
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = TestResizeObserver;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = TestResizeObserver;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
