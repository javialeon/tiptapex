// Upload wiring against a real editor under jsdom: what reaches the document
// when files are pasted. `fetch` is stubbed per check; no request leaves the
// process.
import assert from "node:assert/strict"

import { dom } from "./dom.mjs"
import { test } from "./harness.mjs"

const { Editor } = await import("@tiptap/core")
const { buildExtensions, uploadAndInsert } = await import("tiptapex")

const UPLOAD = { url: "/uploads", scopeName: null, scopeValue: "", csrfToken: "t" }

function editor(upload = UPLOAD) {
  const element = dom.window.document.createElement("div")
  dom.window.document.body.appendChild(element)

  return new Editor({
    element,
    content: { type: "doc", content: [{ type: "paragraph" }] },
    extensions: buildExtensions({
      dragHandle: false,
      page: false,
      onUploadFiles: (e, files, pos) => uploadAndInsert(e, files, pos, upload),
    }),
  })
}

// Checks run side by side and each one replaces the stub, so every restore
// goes back to the real fetch rather than to whichever stub came before.
const NATIVE_FETCH = globalThis.fetch

function stubFetch(respond) {
  globalThis.fetch = async (...args) => respond(...args)
  return () => (globalThis.fetch = NATIVE_FETCH)
}

const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

// ProseMirror's own paste handler, fed the clipboard a browser hands it.
function paste(e, { files, html, text = "" }) {
  const event = new dom.window.Event("paste", { bubbles: true, cancelable: true })
  event.clipboardData = {
    files,
    types: html ? ["Files", "text/html", "text/plain"] : ["Files"],
    getData: (type) => (type === "text/html" ? html : type === "text/plain" ? text : ""),
  }
  e.view.dom.dispatchEvent(event)
}

const imageSources = (e) => {
  const sources = []
  e.state.doc.descendants((node) => {
    if (node.type.name === "image") sources.push(node.attrs.src)
  })
  return sources
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
const png = () => new File(["png"], "photo.png", { type: "image/png" })

const t = (name, fn) => test("uploads (jsdom)", name, fn)

t("a paste whose HTML has text keeps the HTML and skips the picture beside it", async () => {
  // Word, Excel and some browsers put a rendering of the copied content on
  // the clipboard next to its HTML. Uploading it inserted a picture of the
  // very text that was pasted.
  let uploads = 0
  const restore = stubFetch(() => {
    uploads++
    return json(200, { url: "/uploads/render.png", content_type: "image/png", filename: "render.png" })
  })
  const e = editor()
  try {
    paste(e, { files: [png()], html: '<meta charset="utf-8"><img src="https://example.com/photo.png"><p>Caption</p>' })
    await tick()

    assert.equal(uploads, 0)
    assert.deepEqual(imageSources(e), ["https://example.com/photo.png"])
    assert.match(e.getText(), /Caption/)
  } finally {
    e.destroy()
    restore()
  }
})

t("a copied image is uploaded and its HTML copy left out", async () => {
  const restore = stubFetch(() =>
    json(200, { url: "/uploads/photo.png", content_type: "image/png", filename: "photo.png" })
  )
  const e = editor()
  try {
    paste(e, { files: [png()], html: '<meta charset="utf-8"><img src="https://example.com/photo.png">' })
    await tick()

    assert.deepEqual(imageSources(e), ["/uploads/photo.png"])
  } finally {
    e.destroy()
    restore()
  }
})

t("an image-only paste is told apart from text by what renders", async () => {
  const restore = stubFetch(() =>
    json(200, { url: "/uploads/photo.png", content_type: "image/png", filename: "photo.png" })
  )
  const e = editor()
  try {
    paste(e, {
      files: [png()],
      html: '<img src="https://example.com/photo.png"><style>p { color: red }</style><p>\u200b</p>',
    })
    await tick()

    assert.deepEqual(imageSources(e), ["/uploads/photo.png"])
  } finally {
    e.destroy()
    restore()
  }
})

t("inside a code block a paste with a picture beside it stays plain text", async () => {
  let uploads = 0
  const restore = stubFetch(() => {
    uploads++
    return json(200, { url: "/uploads/render.png", content_type: "image/png", filename: "render.png" })
  })
  const e = editor()
  try {
    e.commands.setContent({ type: "doc", content: [{ type: "codeBlock" }] })
    e.commands.setTextSelection(1)
    paste(e, { files: [png()], html: "<p><b>let</b> x = 1</p>", text: "let x = 1" })
    await tick()

    assert.equal(uploads, 0)
    const code = e.state.doc.firstChild
    assert.equal(code.type.name, "codeBlock")
    assert.equal(code.textContent, "let x = 1")
  } finally {
    e.destroy()
    restore()
  }
})
