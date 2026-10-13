import ode from "./art/ode.svg";
import star from "./art/star.svg";
export const cover = (id: string) => (id === "ode" ? ode : star);
export function Brand() {
  return (
    <span className="brand-lockup">
      <svg width="30" height="32" viewBox="0 0 34 34" aria-hidden="true">
        <g fill="currentColor">
          <rect x="0" y="20" width="9" height="4" rx="2" />
          <rect x="12" y="9" width="9" height="4" rx="2" />
          <rect x="24" y="2" width="9" height="4" rx="2" />
          <rect x="0" y="29" width="9" height="4" rx="2" />
          <rect x="12" y="20" width="9" height="4" rx="2" />
          <rect x="24" y="12" width="9" height="4" rx="2" />
        </g>
      </svg>
      <span>перепев</span>
    </span>
  );
}
