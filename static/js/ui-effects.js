const BACKGROUNDS = Object.freeze([
  "/static/images/backgrounds/1.jpg",
  "/static/images/backgrounds/2.jpg",
  "/static/images/backgrounds/3.jpg",
  "/static/images/backgrounds/4.jpg",
  "/static/images/backgrounds/5.jpg",
  "/static/images/backgrounds/6.jpg",
  "/static/images/backgrounds/7.jpg",
  "/static/images/backgrounds/8.jpg",
  "/static/images/backgrounds/9.jpg",
  "/static/images/backgrounds/10.jpg",
]);

function getGlassOptions(element) {
  const isMobile = window.matchMedia("(max-width: 760px)").matches;
  const isTargetPopup =
    element &&
    (element.closest("#change-password-modal") ||
      element.closest("#edit-album-modal") ||
      element.closest("#edit-poll-modal") ||
      element.closest("#new-chat-modal"));
  return {
    radius: isMobile ? 32 : 60,
    bezelWidth: 20,
    glassThickness: 300,
    blur: isTargetPopup ? 3 : 0,
    refractiveIndex: 1.5,
    surface: "convexSquircle",
    specularOpacity: 1,
  };
}

function pickRandomBackground() {
  return BACKGROUNDS[Math.floor(Math.random() * BACKGROUNDS.length)];
}

function setRandomBackground() {
  const background = pickRandomBackground();
  document.documentElement.style.setProperty("--page-background", `url("${background}")`);
  document.documentElement.style.setProperty("--page-background-position", "center");
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = background;
  img.onload = () => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 100;
      canvas.height = 50;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, 100, 50);
      const imgData = ctx.getImageData(0, 0, 100, 50).data;
      const colVibrancies = [];
      for (let x = 0; x < 100; x++) {
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        for (let y = 0; y < 50; y++) {
          const idx = (y * 100 + x) * 4;
          sumR += imgData[idx];
          sumG += imgData[idx + 1];
          sumB += imgData[idx + 2];
        }
        const meanR = sumR / 50;
        const meanG = sumG / 50;
        const meanB = sumB / 50;
        let varR = 0;
        let varG = 0;
        let varB = 0;
        for (let y = 0; y < 50; y++) {
          const idx = (y * 100 + x) * 4;
          varR += Math.pow(imgData[idx] - meanR, 2);
          varG += Math.pow(imgData[idx + 1] - meanG, 2);
          varB += Math.pow(imgData[idx + 2] - meanB, 2);
        }
        const stdR = Math.sqrt(varR / 50);
        const stdG = Math.sqrt(varG / 50);
        const stdB = Math.sqrt(varB / 50);
        colVibrancies.push((stdR + stdG + stdB) / 3.0);
      }
      const vibrancies = [];
      const halfWin = 13;
      for (let x = 0; x < 100; x++) {
        const start = Math.max(0, x - halfWin);
        const end = Math.min(100, x + halfWin);
        let sum = 0;
        for (let wx = start; wx < end; wx++) {
          sum += colVibrancies[wx];
        }
        vibrancies.push(sum / (end - start));
      }
      let maxVib = 0;
      for (let i = 0; i < 100; i++) {
        if (vibrancies[i] > maxVib) {
          maxVib = vibrancies[i];
        }
      }
      const threshold = maxVib * 0.75;
      const goodPositions = [];
      for (let i = 0; i < 100; i++) {
        if (vibrancies[i] >= threshold) {
          goodPositions.push(i);
        }
      }
      if (goodPositions.length > 0) {
        const chosenX = goodPositions[Math.floor(Math.random() * goodPositions.length)];
        document.documentElement.style.setProperty("--page-background-position", `${chosenX}% center`);
      }
    } catch (e) {
    }
  };
}

function mountGlassFilter(createLiquidGlass, element, registry) {
  const rect = element.getBoundingClientRect();
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);

  if (!width || !height) {
    return;
  }

  const current = registry.get(element);
  if (current && current.width === width && current.height === height) {
    return;
  }

  if (current?.svg) {
    current.svg.remove();
  }

  const glass = createLiquidGlass({
    width,
    height,
    ...getGlassOptions(element),
  });

  const holder = document.createElement("div");
  holder.innerHTML = glass.svgFilter;
  const svg = holder.firstElementChild;

  if (svg) {
    svg.setAttribute("aria-hidden", "true");
    svg.style.position = "absolute";
    svg.style.width = "0";
    svg.style.height = "0";
    svg.style.overflow = "hidden";
    svg.style.pointerEvents = "none";
    document.body.appendChild(svg);
  }

  element.style.setProperty("--liquid-glass-filter", glass.filterRef);
  element.style.backdropFilter = glass.filterRef;
  element.style.WebkitBackdropFilter = glass.filterRef;
  element.dataset.liquidGlassMounted = "true";
  registry.set(element, { svg, width, height });
}

export function initPageEffects(createLiquidGlass) {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }

  setRandomBackground();

  if (typeof createLiquidGlass !== "function") {
    return () => {};
  }

  const registry = new Map();
  let elements = [];

  const syncElements = () => {
    elements = Array.from(document.querySelectorAll("[data-liquid-glass]"));

    for (const element of elements) {
      if (registry.has(element)) continue;
      registry.set(element, { svg: null, width: 0, height: 0 });
      if (resizeObserver) {
        resizeObserver.observe(element);
      }
    }

    for (const element of Array.from(registry.keys())) {
      if (elements.includes(element)) continue;
      const current = registry.get(element);
      current?.svg?.remove();
      element.style.removeProperty("--liquid-glass-filter");
      element.style.removeProperty("backdrop-filter");
      element.style.removeProperty("-webkit-backdrop-filter");
      delete element.dataset.liquidGlassMounted;
      resizeObserver?.unobserve(element);
      registry.delete(element);
    }
  };

  const refreshAll = () => {
    syncElements();
    let i = 0;
    const step = () => {
      if (i < elements.length) {
        mountGlassFilter(createLiquidGlass, elements[i], registry);
        i++;
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  };

  const resizeObserver =
    typeof ResizeObserver === "function"
      ? new ResizeObserver((entries) => {
          for (const entry of entries) {
            mountGlassFilter(createLiquidGlass, entry.target, registry);
          }
        })
      : null;

  syncElements();
  refreshAll();
  window.addEventListener("resize", refreshAll);
  window.addEventListener("liquid-glass:refresh", refreshAll);

  return () => {
    window.removeEventListener("resize", refreshAll);
    window.removeEventListener("liquid-glass:refresh", refreshAll);
    resizeObserver?.disconnect();

    for (const { svg } of registry.values()) {
      svg?.remove();
    }

    for (const element of elements) {
      element.style.removeProperty("--liquid-glass-filter");
      element.style.removeProperty("backdrop-filter");
      element.style.removeProperty("-webkit-backdrop-filter");
      delete element.dataset.liquidGlassMounted;
    }

    registry.clear();
  };
}
