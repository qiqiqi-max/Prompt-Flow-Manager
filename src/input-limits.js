// Native maxlength clips pasted logs before application validation can warn.
// Keep the attempted input and check it on input and again at submission.
const INPUT_LIMITS = {
  bind(inputs, buttons, translate, isBusy = () => false) {
    const fields = inputs.map(input => {
      const error = input.ownerDocument.createElement('div');
      error.id = input.id + '-length-error';
      error.className = 'input-length-error';
      error.setAttribute('aria-live', 'polite');
      input.setAttribute('aria-describedby', error.id);
      input.insertAdjacentElement('afterend', error);
      return { input, error, max: Number(input.dataset.maxLength) };
    });
    const validate = (focus = false) => {
      let firstInvalid = null;
      for (const { input, error, max } of fields) {
        const invalid = input.value.length > max;
        input.setAttribute('aria-invalid', String(invalid));
        error.textContent = invalid ? translate('inputTooLong', { length: input.value.length, max }) : '';
        error.hidden = !invalid;
        if (invalid && !firstInvalid) firstInvalid = input;
      }
      for (const button of buttons) button.disabled = !!firstInvalid || isBusy();
      if (focus && firstInvalid) firstInvalid.focus();
      return !firstInvalid;
    };
    for (const input of inputs) input.addEventListener('input', () => validate());
    validate();
    return validate;
  }
};
if (typeof module !== 'undefined' && module.exports) module.exports = INPUT_LIMITS;
