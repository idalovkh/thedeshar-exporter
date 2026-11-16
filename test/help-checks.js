export async function runHelpChecks(previewWindow) {
  const document = previewWindow.document;
  const passed = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); passed.push(message); };
  const waitFor = async (condition, message) => {
    const deadline = Date.now() + 10000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(message);
      await new Promise(resolve => previewWindow.setTimeout(resolve, 20));
    }
  };
  await waitFor(() => previewWindow.__exporterPreview && document.querySelector('#collect-book:not([disabled]):not([hidden])'),
    'The ready fixture must initialize before testing help.');

  const trigger = document.querySelector('#open-help');
  const dialog = document.querySelector('#help-dialog');
  const title = document.querySelector('#help-title');
  if (!trigger || !dialog || !title) throw new Error('The shipping help entry point, dialog and title are required.');
  const closes = [...dialog.querySelectorAll('[data-close-help]')];
  if (closes.length !== 2) throw new Error('Both help close controls must be present.');
  const collectionButton = document.querySelector('#collect-book');
  const preview = previewWindow.__exporterPreview;
  const controls = () => ['collect-book', 'export', 'cancel-collection', 'cancel', 'download-diagnostics']
    .map(id => {
      const element = document.getElementById(id);
      return { id, hidden: element.hidden, disabled: element.disabled, text: element.textContent };
    });
  const before = {
    state: JSON.stringify(preview.state),
    navigation: JSON.stringify(preview.navigation),
    controls: JSON.stringify(controls()),
    source: document.querySelector('#source-name').textContent,
    calls: preview.calls.length,
  };
  check(!dialog.open, 'Instructions start closed and do not block collection.');

  trigger.focus();
  trigger.click();
  await waitFor(() => dialog.open, 'The help button must open the instructions.');
  check(dialog.matches(':modal'), 'Instructions open as a native modal dialog.');
  check(dialog.getAttribute('aria-labelledby')?.split(/\s+/).some(id => document.getElementById(id) === title),
    'The modal has an accessible name supplied by its visible title.');
  check(document.activeElement === title, 'Opening help focuses the instruction title.');
  collectionButton.focus();
  check(document.activeElement !== collectionButton && dialog.contains(document.activeElement),
    'The modal prevents focus from moving to collection controls behind it.');

  const details = [...dialog.querySelectorAll('details')];
  check(details.length === 2 && details.every(item => !item.open), 'Troubleshooting and update tips start collapsed.');
  for (const detail of details) {
    const summary = detail.querySelector('summary');
    if (!summary) throw new Error('Every help tip requires a summary control.');
    summary.click();
    check(detail.open, `The “${summary.textContent.trim()}” tip expands.`);
    summary.click();
    check(!detail.open, `The “${summary.textContent.trim()}” tip collapses.`);
  }

  for (const [index, button] of closes.entries()) {
    if (index > 0) { trigger.focus(); trigger.click(); }
    button.click();
    await waitFor(() => !dialog.open, 'The close control must dismiss the instructions.');
    check(!dialog.matches(':modal') && document.activeElement === trigger,
      `Closing with “${button.getAttribute('aria-label') || button.textContent.trim()}” restores focus to the help button.`);
  }
  check(document.querySelector('#source-name').textContent === before.source &&
    JSON.stringify(preview.navigation) === before.navigation,
    'Opening and closing help preserves the selected source book.');
  check(JSON.stringify(preview.state) === before.state && !preview.collectionOwned,
    'Instructions do not start collection or change saved materials.');
  check(JSON.stringify(controls()) === before.controls,
    'Source, collection and download controls keep their previous state.');
  check(preview.calls.slice(before.calls).every(call => call.type.startsWith('GET_')),
    'Help sends no commands that change the source or collected materials.');
  return passed;
}
