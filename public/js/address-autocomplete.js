(function (global) {
  // Keep focus on the input: options are read through aria-activedescendant.
  function attach(input, { search, presets = [], onChange = () => {} }) {
    const wrapper = input.parentElement;
    const list = document.createElement('ul');
    list.id = input.id + '-suggestions';
    list.className = 'address-suggestions';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', input.id === 'pickup' ? 'Pickup suggestions' : 'Dropoff suggestions');
    list.hidden = true;
    const status = document.createElement('p');
    status.id = input.id + '-suggestion-status';
    status.className = 'address-suggestion-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;
    wrapper.append(list, status);
    input.removeAttribute('list');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', list.id);
    input.setAttribute('aria-describedby', status.id);
    input.setAttribute('aria-expanded', 'false');

    let selected = null;
    let options = [];
    let active = -1;
    let revision = 0;
    let debounce;
    let controller;
    let interactingWithList = false;
    let composing = false;

    function cancelSearch() {
      revision++;
      clearTimeout(debounce);
      controller?.abort();
      controller = null;
      input.removeAttribute('aria-busy');
    }

    function announce(message) {
      status.textContent = message;
      status.hidden = !message;
    }

    function setActive(index) {
      active = index;
      Array.from(list.children).forEach((option, i) => {
        option.setAttribute('aria-selected', String(i === active));
      });
      if (active < 0) input.removeAttribute('aria-activedescendant');
      else {
        input.setAttribute('aria-activedescendant', list.children[active].id);
        list.children[active].scrollIntoView({ block: 'nearest' });
      }
    }

    function close() {
      cancelSearch();
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      setActive(-1);
      announce('');
    }

    function render(places) {
      options = places.slice(0, 5);
      list.replaceChildren();
      options.forEach((place, index) => {
        const option = document.createElement('li');
        option.id = list.id + '-' + index;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', 'false');
        // Provider text is untrusted; never insert it as HTML.
        option.textContent = place.label;
        option.addEventListener('click', () => {
          setPlace(place);
          input.focus({ preventScroll: true });
        });
        list.appendChild(option);
      });
      setActive(-1);
      list.hidden = !options.length;
      input.setAttribute('aria-expanded', String(options.length > 0));
    }

    function setPlace(place) {
      close();
      selected = { label: place.label, lat: place.lat, lon: place.lon };
      input.value = place.label;
      onChange();
    }

    function schedule() {
      cancelSearch();
      render([]);
      announce('');
      const q = input.value.trim();
      if (composing || q.length < 3) return;
      const local = presets
        .filter((p) => (p.label + ' ' + p.address).toLowerCase().includes(q.toLowerCase()))
        .map((p) => ({ label: p.address, lat: p.lat, lon: p.lon }));
      render(local);
      // Exact curated places already have reliable coordinates.
      if (presets.some((p) => [p.label, p.address].some((s) => s.toLowerCase() === q.toLowerCase()))) return;
      const requestRevision = revision;
      debounce = setTimeout(async () => {
        controller = new AbortController();
        const requestController = controller;
        const timeout = setTimeout(() => requestController.abort(), 6000);
        input.setAttribute('aria-busy', 'true');
        announce('Finding address suggestions…');
        try {
          const results = await search(q, { signal: requestController.signal });
          if (revision !== requestRevision || input.value.trim() !== q) return;
          const merged = [...local, ...results].filter((place, i, all) =>
            all.findIndex((p) => p.label === place.label) === i);
          render(merged);
          announce(options.length
            ? options.length + ' suggestions. Choose an address, or use arrows and Enter.'
            : 'No KC metro suggestions found. You can still type a full address.');
        } catch (err) {
          if (revision !== requestRevision || input.value.trim() !== q) return;
          render(local);
          announce('Suggestions unavailable. You can still type a full address or choose a popular place.');
        } finally {
          clearTimeout(timeout);
          if (revision === requestRevision) {
            input.removeAttribute('aria-busy');
            controller = null;
          }
        }
      }, 400);
    }

    input.addEventListener('input', () => {
      selected = null;
      onChange();
      schedule();
    });
    input.addEventListener('compositionstart', () => { composing = true; close(); });
    input.addEventListener('compositionend', () => { composing = false; schedule(); });
    input.addEventListener('focus', () => { if (!getSelection()) schedule(); });
    input.addEventListener('blur', () => { if (!interactingWithList) close(); });
    input.addEventListener('keydown', (event) => {
      if (event.isComposing || composing) return;
      if (event.key === 'Escape') {
        if (!list.hidden) event.preventDefault();
        close();
      } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !list.hidden) {
        event.preventDefault();
        const next = event.key === 'ArrowDown'
          ? (active + 1) % options.length
          : (active <= 0 ? options.length : active) - 1;
        setActive(next);
      } else if (event.key === 'Enter' && !list.hidden && active >= 0) {
        event.preventDefault();
        setPlace(options[active]);
      }
    });

    // Allow touch scrolling without closing the list before its click arrives.
    list.addEventListener('pointerdown', (event) => {
      interactingWithList = true;
      if (event.pointerType === 'mouse') event.preventDefault();
    });
    // Also suppress the compatibility mouse event emitted after a touch tap.
    list.addEventListener('mousedown', (event) => event.preventDefault());
    list.addEventListener('pointerup', () => {
      interactingWithList = false;
      // Touch browsers can dispatch click after pointerup in a later task.
      // Keep options mounted until that click or an outside interaction.
    });
    list.addEventListener('pointercancel', () => {
      interactingWithList = false;
      if (document.activeElement !== input) close();
    });
    document.addEventListener('pointerdown', (event) => {
      if (!wrapper.contains(event.target)) {
        interactingWithList = false;
        close();
      }
    });

    function getSelection() {
      return selected && selected.label === input.value ? selected : null;
    }
    return { getSelection, setPlace, close };
  }

  global.JRidesAddressAutocomplete = { attach };
})(typeof window !== 'undefined' ? window : globalThis);
