import { THEME_ICON, THEME_LABEL, nextPreference, type ThemePreference, type ResolvedTheme } from "./theme.js";

const PREFERENCES: ThemePreference[] = ["light", "dark", "system"];

/**
 * The quick control in the persistent header: one button that steps
 * light → dark → system. The label says what is active, including which way
 * "system" currently resolves, so the button is never ambiguous.
 */
export function ThemeToggle({ preference, resolved, onChange }: {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  onChange: (preference: ThemePreference) => void;
}) {
  const following = preference === "system" ? ` (currently ${resolved})` : "";
  return (
    <button
      type="button"
      className="theme-toggle"
      title={`Theme: ${THEME_LABEL[preference]}${following}. Switch to ${THEME_LABEL[nextPreference(preference)]}.`}
      aria-label={`Theme: ${THEME_LABEL[preference]}${following}. Switch to ${THEME_LABEL[nextPreference(preference)]}.`}
      onClick={() => onChange(nextPreference(preference))}
    >
      <span aria-hidden="true">{THEME_ICON[preference]}</span>
      <small>{THEME_LABEL[preference]}</small>
    </button>
  );
}

/** The explicit three-way choice, for the account menu where there is room to show it. */
export function ThemeChoice({ preference, onChange }: {
  preference: ThemePreference;
  onChange: (preference: ThemePreference) => void;
}) {
  return (
    <div className="theme-choice" role="group" aria-label="Colour theme">
      {PREFERENCES.map((option) => (
        <button
          key={option}
          type="button"
          className={option === preference ? "selected" : ""}
          aria-pressed={option === preference}
          onClick={() => onChange(option)}
        >
          <span aria-hidden="true">{THEME_ICON[option]}</span>{THEME_LABEL[option]}
        </button>
      ))}
    </div>
  );
}
