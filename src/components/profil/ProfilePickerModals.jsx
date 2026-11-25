"use client";

// src/components/profil/ProfilePickerModals.jsx
//
// The four profile cosmetics pickers, in one place. They are pure wiring: the
// page keeps the state, the ownership data and the equip handlers, so this
// component can never grant, unlock or bill anything — it only opens the
// picker the player clicked and reports the choice back.

import ChooseIconModal from "../ChooseIconModal";
import ChooseGlowModal from "../ChooseGlowModal";
import ChooseFrameModal from "../ChooseFrameModal";
import ChooseEmotesModal from "../ChooseEmotesModal";

export default function ProfilePickerModals({
  isIconPickerOpen,
  onCloseIconPicker,
  currentIconKey,
  onEquipIcon,
  isGlowPickerOpen,
  onCloseGlowPicker,
  onEquipGlow,
  isFramePickerOpen,
  onCloseFramePicker,
  onEquipCosmetic,
  isEmotesManagerOpen,
  onCloseEmotesManager,
}) {
  return (
    <>
      {/* Official Grynd icon picker — owned icons only, no uploads. */}
      <ChooseIconModal
        open={isIconPickerOpen}
        onClose={onCloseIconPicker}
        currentIconKey={currentIconKey}
        onEquipped={onEquipIcon}
      />

      {/* Catalog-granted name glow picker — owned glows only. */}
      <ChooseGlowModal
        open={isGlowPickerOpen}
        onClose={onCloseGlowPicker}
        onEquipped={onEquipGlow}
      />

      {/* The single profile-cosmetics picker: owned frames + badges + avatar /
          username / chat effects + glows, all equippable in one place. */}
      <ChooseFrameModal
        open={isFramePickerOpen}
        onClose={onCloseFramePicker}
        onEquipped={({ category, item }) => onEquipCosmetic(category, item)}
      />

      {/* In-game emote loadout manager — equipped animated emotes (max 9). */}
      <ChooseEmotesModal
        open={isEmotesManagerOpen}
        onClose={onCloseEmotesManager}
      />
    </>
  );
}
