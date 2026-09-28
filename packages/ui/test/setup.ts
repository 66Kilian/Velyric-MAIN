import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

Object.defineProperty(globalThis, 'ResizeObserver', { value: ResizeObserverStub, writable: true });

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

Element.prototype.scrollIntoView = function scrollIntoView() {};
Element.prototype.hasPointerCapture = function hasPointerCapture() {
  return false;
};
Element.prototype.releasePointerCapture = function releasePointerCapture() {};

afterEach(() => {
  cleanup();
});
