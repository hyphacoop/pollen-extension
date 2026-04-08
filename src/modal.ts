/**
 * Claim text modal UI for Pollen claims.
 */

/**
 * Show a modal for the user to enter claim text.
 * Returns the text on submit, or null if cancelled.
 */
export function showClaimModal(
  thumbUrl: string,
  alt: string
): Promise<string | null> {
  return new Promise((resolve) => {
    // Backdrop
    const backdrop = document.createElement("div");
    backdrop.className = "pollen-modal-backdrop";

    // Modal container
    const modal = document.createElement("div");
    modal.className = "pollen-modal";

    // Header
    const header = document.createElement("div");
    header.className = "pollen-modal-header";
    header.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="7" fill="#f59e0b" stroke="#d97706" stroke-width="1"/>
        <path d="M5 8.5L7 10.5L11 6" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Pollen Claim
    `;

    // Image preview
    const preview = document.createElement("img");
    preview.src = thumbUrl;
    preview.alt = alt;
    preview.className = "pollen-modal-preview";

    // Textarea
    const textarea = document.createElement("textarea");
    textarea.placeholder = "Describe the provenance of this image...";
    textarea.className = "pollen-modal-textarea";

    // Button row
    const buttons = document.createElement("div");
    buttons.className = "pollen-modal-buttons";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.className = "pollen-modal-cancel";

    const submitBtn = document.createElement("button");
    submitBtn.textContent = "Submit";
    submitBtn.disabled = true;
    submitBtn.className = "pollen-modal-submit";

    // --- Event handlers ---

    function updateSubmitState(): void {
      const empty = textarea.value.trim().length === 0;
      submitBtn.disabled = empty;
    }

    textarea.addEventListener("input", updateSubmitState);

    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") handleCancel();
    }

    function cleanup(): void {
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
    }

    function handleCancel(): void {
      cleanup();
      resolve(null);
    }

    function handleSubmit(): void {
      if (submitBtn.disabled) return;
      const text = textarea.value.trim();
      cleanup();
      resolve(text);
    }

    cancelBtn.addEventListener("click", handleCancel);
    submitBtn.addEventListener("click", handleSubmit);

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) handleCancel();
    });

    document.addEventListener("keydown", onKey);

    // Assemble
    buttons.append(cancelBtn, submitBtn);
    modal.append(header, preview, textarea, buttons);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    // Focus textarea
    textarea.focus();
  });
}
