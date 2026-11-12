"use client";

import * as React from "react";

export function useReducedMotion(): boolean {
  const [prefersReduced, setPrefersReduced] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReduced(mediaQuery.matches);

    const listener = (event: MediaQueryListEvent) => {
      setPrefersReduced(event.matches);
    };

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", listener);
      return () => mediaQuery.removeEventListener("change", listener);
    } else {
      // Compatibility for older browsers
      mediaQuery.addListener(listener);
      return () => mediaQuery.removeListener(listener);
    }
  }, []);

  return prefersReduced;
}

export interface ScrollRevealProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  direction?: "up" | "down" | "fade" | "scale";
  delayMs?: number;
  staggerIndex?: number;
  threshold?: number;
  className?: string;
}

export function ScrollReveal({
  children,
  direction = "up",
  delayMs = 0,
  staggerIndex = 0,
  threshold = 0.12,
  className = "",
  style,
  ...props
}: ScrollRevealProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = React.useState(false);
  const reducedMotion = useReducedMotion();

  React.useEffect(() => {
    if (reducedMotion) {
      setIsVisible(true);
      return;
    }

    const currentRef = ref.current;
    if (!currentRef) return;

    if (typeof IntersectionObserver === "undefined") {
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true);
            observer.unobserve(entry.target);
          }
        });
      },
      {
        threshold,
        rootMargin: "0px 0px -40px 0px",
      }
    );

    observer.observe(currentRef);

    return () => {
      if (currentRef) observer.unobserve(currentRef);
    };
  }, [threshold, reducedMotion]);

  const computedDelay = delayMs + staggerIndex * 70;

  const animationClass = React.useMemo(() => {
    if (!isVisible) return "opacity-0";
    if (reducedMotion) return "opacity-100";
    switch (direction) {
      case "up":
        return "animate-fade-in-up";
      case "down":
        return "animate-fade-in-down";
      case "scale":
        return "animate-scale-in";
      case "fade":
      default:
        return "animate-fade-in";
    }
  }, [isVisible, direction, reducedMotion]);

  return (
    <div
      ref={ref}
      style={{
        ...style,
        animationDelay: isVisible && !reducedMotion ? `${computedDelay}ms` : undefined,
      }}
      className={`${animationClass} ${className}`.trim()}
      {...props}
    >
      {children}
    </div>
  );
}

export interface AnimatedNumberProps {
  value: number;
  prefix?: string;
  decimals?: number;
  className?: string;
}

export function AnimatedNumber({
  value,
  prefix = "$",
  decimals = 2,
  className = "",
}: AnimatedNumberProps) {
  const [displayValue, setDisplayValue] = React.useState(value);
  const reducedMotion = useReducedMotion();

  React.useEffect(() => {
    if (reducedMotion) {
      setDisplayValue(value);
      return;
    }

    const startValue = displayValue;
    const diff = value - startValue;
    if (Math.abs(diff) < 0.001) {
      setDisplayValue(value);
      return;
    }

    const duration = 280; // ms
    const startTime = performance.now();

    let animationFrameId: number;

    const tick = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic: 1 - Math.pow(1 - progress, 3)
      const easeProgress = 1 - Math.pow(1 - progress, 3);
      const current = startValue + diff * easeProgress;
      setDisplayValue(current);

      if (progress < 1) {
        animationFrameId = requestAnimationFrame(tick);
      } else {
        setDisplayValue(value);
      }
    };

    animationFrameId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [value, reducedMotion]);

  return (
    <span className={`font-mono transition-colors duration-150 ${className}`.trim()}>
      {prefix}
      {displayValue.toFixed(decimals)}
    </span>
  );
}

