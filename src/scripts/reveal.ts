// Content stays visible without JavaScript．Only newly entered sections animate，once．
const targets = [
  ".about-content", ".about-facts", ".home-status-inner", ".activities-heading",
  ".activity-list li", ".latest-grid", ".explore-intro", ".explore-link", ".join > *",
].join(",");

const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
const animations = new Map<Element, Animation>();
const revealed = new WeakSet<Element>();
let observer: IntersectionObserver | undefined;

const observe = () => {
  observer?.disconnect();
  if (motion.matches || !("IntersectionObserver" in window)) return;
  observer = new IntersectionObserver((entries) => {
    for (const { target, isIntersecting } of entries) {
      if (!isIntersecting) continue;
      observer?.unobserve(target);
      revealed.add(target);
      if (motion.matches || target.contains(document.activeElement)) continue;

      // translate does not affect wrapping or compete with hover transforms．
      const animation = target.animate([
        { opacity: 0, translate: "0 1.25rem" },
        { opacity: 1, translate: "0 0" },
      ], { duration: 420, easing: "cubic-bezier(0.2, 0.65, 0.3, 1)" });
      animations.set(target, animation);
      const forget = () => animations.delete(target);
      animation.addEventListener("finish", forget, { once: true });
      animation.addEventListener("cancel", forget, { once: true });
    }
  });

  for (const target of document.querySelectorAll(targets)) {
    // Do not fade out text that is already visible，including at a deep link．
    if (revealed.has(target)) continue;
    if (target.getBoundingClientRect().top < window.innerHeight) revealed.add(target);
    else observer.observe(target);
  }
};

motion.addEventListener("change", () => {
  observer?.disconnect();
  for (const animation of animations.values()) animation.cancel();
  animations.clear();
  observe();
});

const showInteractiveContent = (event: Event) => {
  for (const [target, animation] of animations) {
    if (event.target instanceof Node && target.contains(event.target)) animation.cancel();
  }
};
document.addEventListener("focusin", showInteractiveContent);
document.addEventListener("pointerover", showInteractiveContent);

// Font replacement may move sections．Measure after the actual fonts have settled．
void document.fonts.ready.then(observe);
