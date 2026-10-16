import { animate, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Animates a headline number when it changes (not on first render, which stays calm).
 * Reduced motion jumps straight to the new value.
 */
export function CountUp({ value, children, duration = 0.6 }: { value: number; children: (value: number) => ReactNode; duration?: number }) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);

  useEffect(() => {
    if (reduce || shownRef.current === value) {
      shownRef.current = value;
      setShown(value);
      return;
    }
    const controls = animate(shownRef.current, value, {
      duration,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => {
        shownRef.current = v;
        setShown(Math.round(v));
      },
    });
    return () => controls.stop();
  }, [value, reduce, duration]);

  return <>{children(shown)}</>;
}
