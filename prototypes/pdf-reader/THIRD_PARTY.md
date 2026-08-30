# Prototype third-party code

This throwaway prototype vendors only the browser files it needs:

- `pdfjs-dist` 6.3.289, Apache-2.0, from Mozilla PDF.js.
- `konva` 10.3.2, MIT.

The production implementation should install these packages normally and let the
application build own worker URLs, dependency updates, and license reporting.
