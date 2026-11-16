/** Wait for this attempt's explicit agreement while retaining downloaded Blobs. */
export function confirmPartialExport({ elements, signal, onReport }) {
  const dialog = elements['partial-export-dialog'];
  const accept = elements['partial-export-accept'];
  const cancel = elements['partial-export-cancel'];
  const report = elements['partial-export-report'];
  const feedback = elements['partial-export-feedback'];
  feedback.hidden = true;
  feedback.textContent = '';
  report.disabled = false;
  report.removeAttribute('aria-busy');
  dialog.returnValue = '';

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (agreed, error) => {
      if (settled) return;
      settled = true;
      accept.removeEventListener('click', approve);
      cancel.removeEventListener('click', decline);
      report.removeEventListener('click', saveReport);
      dialog.removeEventListener('cancel', dismiss);
      dialog.removeEventListener('close', decline);
      signal.removeEventListener('abort', decline);
      if (dialog.open) dialog.close();
      if (error) reject(error);
      else resolve(agreed && !signal.aborted);
    };
    const approve = () => finish(true);
    const decline = () => finish(false);
    const dismiss = event => { event.preventDefault(); finish(false); };
    const saveReport = async () => {
      report.disabled = true;
      report.setAttribute('aria-busy', 'true');
      try {
        await onReport();
        if (!settled) {
          feedback.textContent = 'Отчёт скачан. Передайте его нам — поможем разобраться.';
          feedback.hidden = false;
        }
      } catch {
        if (!settled) {
          feedback.textContent = 'Не удалось скачать отчёт. Попробуйте ещё раз.';
          feedback.hidden = false;
        }
      } finally {
        if (!settled) { report.disabled = false; report.removeAttribute('aria-busy'); }
      }
    };
    accept.addEventListener('click', approve);
    cancel.addEventListener('click', decline);
    report.addEventListener('click', saveReport);
    dialog.addEventListener('cancel', dismiss);
    dialog.addEventListener('close', decline);
    signal.addEventListener('abort', decline, { once: true });
    if (signal.aborted) { finish(false); return; }
    try {
      dialog.showModal();
      cancel.focus();
    } catch (error) {
      finish(false, error);
    }
  });
}
