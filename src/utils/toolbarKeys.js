// Arrow-key movement for a role="toolbar" container, on top of normal Tab order: Left/Right move
// between the enabled buttons (wrapping), Home/End jump to the ends. Shared by the library's
// BulkBar and the Trash view's TrashBar. Call it from the toolbar's onKeyDown.
export function handleToolbarArrowKeys(event, container) {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
  if (!keys.includes(event.key) || !container) return
  const buttons = [...container.querySelectorAll('button:not(:disabled)')]
  const index = buttons.indexOf(document.activeElement)
  if (index === -1) return
  event.preventDefault()
  let next = index
  if (event.key === 'ArrowRight') next = (index + 1) % buttons.length
  if (event.key === 'ArrowLeft') next = (index - 1 + buttons.length) % buttons.length
  if (event.key === 'Home') next = 0
  if (event.key === 'End') next = buttons.length - 1
  buttons[next].focus()
}
