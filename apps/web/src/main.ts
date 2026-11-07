import {
  adviseHelm,
  bestVmgAngles,
  bearing,
  boatSpeed,
  buildCourse,
  type CourseDef,
  chooseCourse,
  courseLengthNm,
  createWindField,
  decodeChallenge,
  dist,
  headingFor,
  MAX_CHALLENGE_ORDERS,
  MAX_NAME_LENGTH,
  type HelmAdvice,
  METRES_PER_NM,
  MSL_ABOVE_DATUM_M,
  nextTarget,
  nextTideExtremum,
  norm180,
  norm360,
  type Order,
  parisDate,
  predictTrack,
  type RaceSnapshot,
  sampleWind,
  type Side,
  startPosition,
  tideAt,
} from "@regate/sim";
import {
  courses,
  forgetPrivateSnapshot,
  loadDaily,
  type LoadedSnapshot,
  loadSnapshot,
  polar,
  purgeOldDays,
  read,
  router,
  seabed,
  write,
} from "./assets.ts";
import { Compass } from "./compass.ts";
import { MapView } from "./map.ts";
import {
  type ActiveChallenge,
  loadHistory,
  loadSavedChallenge,
  loadSavedRace,
  PLAYER_COLOR,
  type RaceEvent,
  RIVAL_ID,
  type SavedRace,
  Session,
} from "./session.ts";
import "./style.css";

const app = document.getElementById("app") as HTMLElement;
const SPEEDS = [1, 10, 30, 60, 120];
const DEFAULT_SPEED = 30;
const ATTRIBUTION =
  "Carte simplifiée, ne pas utiliser pour la navigation. Côte © contributeurs OpenStreetMap (ODbL). " +
  "Fonds marins EMODnet Bathymetry (CC BY 4.0). Météo et marée : Open-Meteo, Météo-France (CC BY 4.0).";

const clock = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });
const hhmm = (t: number): string => clock.format(new Date(t * 1000));
const nm = (m: number): string => `${(m / METRES_PER_NM).toFixed(1)} M`;
const COMPASS_POINTS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
const windName = (d: number): string => COMPASS_POINTS[Math.round(norm360(d) / 45) % 8];
const sideName = (s: Side): string => (s === "port" ? "bâbord" : "tribord");

function duration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min ${String(sec).padStart(2, "0")}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  html?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function pickCourse(loaded: LoadedSnapshot, forcedId: string | null): CourseDef {
  const forced = courses.find((c) => c.id === forcedId);
  if (forced) return forced;
  const ofTheDay = courses.find((c) => c.id === loaded.courseId);
  if (ofTheDay) return ofTheDay;
  const snapshot = loaded.snapshot;
  const previous = loadHistory().find((h) => h.date !== snapshot.date)?.course ?? null;
  const previousId = courses.find((c) => c.name === previous)?.id ?? null;
  return chooseCourse(
    courses,
    createWindField(snapshot.wind),
    snapshot.tide,
    seabed,
    snapshot.startT,
    snapshot.closeT,
    polar.draftM,
    previousId,
  ).course.def;
}

interface WindSummary {
  dir: number;
  avg: number;
  gust: number;
}

function summarizeWind(s: RaceSnapshot): WindSummary {
  const nPts = s.wind.lats.length * s.wind.lons.length;
  let u = 0;
  let v = 0;
  let speed = 0;
  let gust = 0;
  let n = 0;
  s.wind.times.forEach((t, k) => {
    if (t < s.startT || t > s.startT + 5 * 3600) return;
    for (let i = k * nPts; i < (k + 1) * nPts; i++) {
      const r = (s.wind.dirDeg[i] * Math.PI) / 180;
      u += Math.sin(r) * s.wind.speedKn[i];
      v += Math.cos(r) * s.wind.speedKn[i];
      speed += s.wind.speedKn[i];
      gust = Math.max(gust, s.wind.gustKn?.[i] ?? 0);
      n++;
    }
  });
  return { dir: norm360((Math.atan2(u, v) * 180) / Math.PI), avg: speed / Math.max(1, n), gust };
}

function tideSummary(s: RaceSnapshot): string {
  const out: string[] = [];
  let t = s.startT - 3600;
  for (let i = 0; i < 6 && out.length < 3; i++) {
    const e = nextTideExtremum(s.tide, t);
    if (!e || e.t > s.closeT) break;
    t = e.t + 1800;
    if (e.t >= s.startT - 1800) {
      out.push(`${e.kind === "high" ? "PM" : "BM"} ${hhmm(e.t)} (${(e.h + MSL_ABOVE_DATUM_M).toFixed(1)} m)`);
    }
  }
  return out.join(" · ") || "Marée régulière";
}

/* Home screen */

function drawPreview(canvas: HTMLCanvasElement, def: CourseDef, snapshot: RaceSnapshot): void {
  const c = buildCourse(def);
  const map = new MapView(canvas, polar.draftM);
  const pts = [c.startA, c.startB, c.finishA, c.finishB, ...c.gates.map((g) => g.buoy)];
  map.fit(pts, 34);
  const field = createWindField(snapshot.wind);
  map.draw(
    {
      course: c,
      nextMark: 0,
      player: null,
      others: [],
      trail: null,
      prediction: null,
      draftHeading: null,
      windAt: (x, y) => sampleWind(field, x, y, snapshot.startT),
      tideM: tideAt(snapshot.tide, snapshot.startT),
    },
    0.1,
  );
}

function showHome(loaded: LoadedSnapshot, challenge: ActiveChallenge | null = null): void {
  app.replaceChildren();
  const { snapshot, live } = loaded;
  const saved = challenge ? loadSavedChallenge(challenge.code) : loadSavedRace(snapshot.date);
  const params = new URLSearchParams(location.search);
  let chosen =
    courses.find((c) => c.id === (challenge?.data.courseId ?? saved?.courseId)) ?? pickCourse(loaded, params.get("course"));
  let speed = saved?.scale ?? read<number>("regate.speed") ?? DEFAULT_SPEED;
  const windInfo = summarizeWind(snapshot);
  const dateLabel = new Intl.DateTimeFormat("fr-FR", { dateStyle: "full", timeZone: "UTC" }).format(
    new Date(`${snapshot.date}T12:00:00Z`),
  );
  const home = el("div", "home");
  const inner = el("div", "home-inner");
  inner.append(el("header", "brand", `<h1>Régate du Bassin</h1><p>Le vent et la marée réels, sur le Bassin d'Arcachon.</p>`));

  const card = el("section", "card");
  card.setAttribute("aria-label", "Course du jour");
  const eyebrow = el("p", "eyebrow");
  // The name comes from someone else's link: it is only ever inserted as text.
  eyebrow.textContent = challenge ? `Défi de ${challenge.data.name} · ${dateLabel}` : `Course du ${dateLabel}`;
  const title = el("h2");
  const desc = el("p", "desc");
  const preview = el("canvas", "preview");
  const facts = el("div", "facts");
  const refresh = (): void => {
    title.textContent = chosen.name;
    desc.textContent = challenge
      ? `${challenge.data.name} ${
          challenge.data.finishS === null ? "n'a pas terminé ce parcours" : `a terminé ce parcours en ${duration(challenge.data.finishS)}`
        }. Même vent, même marée : son bateau navigue à côté du vôtre.`
      : chosen.description;
    const length = courseLengthNm(buildCourse(chosen));
    facts.innerHTML = `
      <div class="fact"><b>${hhmm(snapshot.startT)} → ${hhmm(snapshot.closeT)}</b><span>Départ et clôture</span></div>
      <div class="fact"><b>${length.toFixed(1)} milles</b><span>${chosen.marks.length} bouée${chosen.marks.length > 1 ? "s" : ""}</span></div>
      <div class="fact"><b>${windName(windInfo.dir)}, ${windInfo.avg.toFixed(0)} nœuds</b><span>Rafales jusqu'à ${windInfo.gust.toFixed(0)} nœuds</span></div>
      <div class="fact"><b>${tideSummary(snapshot)}</b><span>Marée à Eyrac</span></div>`;
    requestAnimationFrame(() => drawPreview(preview, chosen, snapshot));
  };

  const controls = el("div", "row");
  const courseField = el("label", "field", "Parcours");
  const courseSelect = el("select");
  for (const c of courses) {
    const o = el("option", undefined, c.id === loaded.courseId && !challenge ? `${c.name} (course du jour)` : c.name);
    o.value = c.id;
    courseSelect.append(o);
  }
  courseSelect.value = chosen.id;
  courseSelect.disabled = saved !== null || challenge !== null;
  courseSelect.addEventListener("change", () => {
    chosen = courses.find((c) => c.id === courseSelect.value) as CourseDef;
    refresh();
  });
  courseField.append(courseSelect);
  const speedField = el("label", "field", "Vitesse du temps");
  const speedSelect = el("select");
  for (const s of SPEEDS) {
    const o = el("option", undefined, s === 1 ? "Temps réel" : `×${s}`);
    o.value = String(s);
    speedSelect.append(o);
  }
  speedSelect.value = String(speed);
  speedSelect.addEventListener("change", () => {
    speed = Number(speedSelect.value);
    write("regate.speed", speed);
  });
  speedField.append(speedSelect);
  controls.append(courseField, speedField);

  const joinLabel = saved ? "Reprendre la course" : challenge ? "Relever le défi" : "Rejoindre la course";
  const join = el("button", "primary wide", joinLabel);
  join.addEventListener("click", () => {
    showGame(loaded, chosen, speed, saved, challenge);
  });

  const notes: string[] = [];
  if (!live) notes.push(`Météo du jour indisponible : course enregistrée du ${snapshot.date}.`);
  else if (loaded.shared) notes.push("Vent AROME de Météo-France et marée du jour, les mêmes pour tous les joueurs.");
  else notes.push("La course commune n'est pas encore publiée : vent et marée récupérés sur cet appareil.");
  notes.push(
    loaded.shared
      ? "5 bots courent aussi. À la fin de la course, vous pourrez défier un ami avec un lien."
      : "Vous courez contre 5 bots. Le lien de défi demande la course commune.",
  );
  const noteEl = el("p", "note", notes.join(" "));
  card.append(eyebrow, title, desc, preview, facts, controls, join, noteEl);
  if (saved) {
    const restart = el("button", "ghost wide", "Recommencer de zéro");
    restart.addEventListener("click", () => {
      if (challenge) {
        write("regate.challenge", null);
      } else {
        write("regate.race", null);
        if (!loaded.shared) forgetPrivateSnapshot(snapshot.date);
      }
      void boot();
    });
    card.append(restart);
  }
  if (challenge) {
    const daily = el("button", "ghost wide", "Voir plutôt la course du jour");
    daily.addEventListener("click", leaveChallengeLink);
    card.append(daily);
  }
  inner.append(card);

  const hist = loadHistory();
  if (hist.length > 0) {
    const section = el("section", "card", "<h3>Vos courses passées</h3>");
    const list = el("ul", "history");
    for (const h of hist.slice(0, 8)) {
      const li = el("li");
      const left = el("span");
      left.textContent = `${h.date.slice(8, 10)}/${h.date.slice(5, 7)} · ${h.course}`;
      const right = el("b");
      right.textContent = h.finishS === null ? `Non classé (${nm(h.remainingM)})` : `${h.rank}e/${h.total} · ${duration(h.finishS)}`;
      li.append(left, right);
      list.append(li);
    }
    section.append(list);
    inner.append(section);
  }
  inner.append(el("p", "legal", ATTRIBUTION));
  home.append(inner);
  app.append(home);
  refresh();
}

/* Game screen */

const TUTORIAL = [
  ["Tournez le compas", "Faites glisser le compas (ou le bateau) pour choisir un cap, puis appuyez sur Valider. Le bateau continue d'avancer, même appli fermée."],
  ["Le vent commande", "Le secteur rouge est interdit : on ne remonte pas droit dans le vent. Les repères verts sont les meilleurs angles. Si la bouée est dans le rouge, il faut tirer des bords."],
  ["La jauge vous guide", "Vert : vous allez vite vers la bouée. Rouge : vous perdez du temps. Le bouton « Meilleur cap » choisit le plus rapide pour vous."],
  ["Attention au sable", "À marée basse, les bancs découvrent. Le sable arrête le bateau, et si l'eau se retire sous vous, il faudra attendre qu'elle remonte. Le curseur du temps montre la marée à venir."],
];

function showGame(
  loaded: LoadedSnapshot,
  def: CourseDef,
  speed: number,
  saved: SavedRace | null,
  challenge: ActiveChallenge | null,
): void {
  app.replaceChildren();
  const session = new Session(loaded.snapshot, def, speed, saved, challenge);
  const world = session.world;
  const root = el("div", "game");
  const canvas = el("canvas", "map");
  canvas.setAttribute("aria-label", "Carte du Bassin d'Arcachon");
  root.append(canvas);

  const hud = el("div", "hud");
  const cells = el("div", "hud-cells");
  const cell = (label: string): { b: HTMLElement; sub: HTMLElement } => {
    const c = el("div", "cell", `<small>${label}</small>`);
    const b = el("b");
    const sub = el("span", "sub");
    c.append(b, sub);
    cells.append(c);
    return { b, sub };
  };
  const cSpeed = cell("Vitesse");
  const cWind = cell("Vent");
  const cTide = cell("Marée");
  const cMark = cell("Prochaine bouée");
  const cRank = cell("Classement");
  const side = el("div", "side-btns");
  const menuBtn = el("button", "icon-btn", "☰");
  menuBtn.setAttribute("aria-label", "Ouvrir le classement et les réglages");
  const recentreBtn = el("button", "icon-btn", "◎");
  recentreBtn.setAttribute("aria-label", "Recentrer sur le bateau");
  const overviewBtn = el("button", "icon-btn", "⤢");
  overviewBtn.setAttribute("aria-label", "Voir tout le parcours");
  side.append(menuBtn, recentreBtn, overviewBtn);
  hud.append(cells, side);
  root.append(hud);

  const banner = el("div", "banner hidden");
  banner.setAttribute("role", "status");
  root.append(banner);

  const timebar = el("div", "timebar");
  const slider = el("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "1000";
  slider.value = "0";
  slider.setAttribute("aria-label", "Voir le vent et la marée à venir");
  const when = el("span", "when");
  const nowBtn = el("button", "ghost hidden", "Maintenant");
  timebar.append(el("span", undefined, "Prévisions"), slider, when, nowBtn);
  root.append(timebar);

  const helm = el("div", "helm");
  const left = el("div", "helm-left");
  const gauge = el("div", "gauge", `<small>Vers la bouée</small><div class="gauge-track"><div class="gauge-pin"></div></div>`);
  const gaugeLabel = gauge.querySelector("small") as HTMLElement;
  const gaugePin = gauge.querySelector(".gauge-pin") as HTMLElement;
  const modes = el("div", "segmented");
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "Mode de barre");
  const modeHeading = el("button", undefined, "Cap fixe");
  const modeTwa = el("button", undefined, "Angle au vent");
  modes.append(modeHeading, modeTwa);
  left.append(gauge, modes);
  const compassCanvas = el("canvas", "compass");
  compassCanvas.setAttribute("aria-label", "Compas : glissez pour choisir le cap");
  const right = el("div", "helm-right");
  const bestBtn = el("button", "ghost", "Meilleur cap");
  const cancelBtn = el("button", "ghost", "Annuler");
  const validateBtn = el("button", "validate", "Valider");
  right.append(bestBtn, cancelBtn, validateBtn);
  helm.append(left, compassCanvas, right);
  root.append(helm);

  const board = el("aside", "board hidden");
  board.setAttribute("aria-label", "Classement");
  const closeBoard = el("button", "icon-btn", "✕");
  closeBoard.setAttribute("aria-label", "Fermer");
  const boardHead = el("header", undefined, "<h2>Classement</h2>");
  boardHead.append(closeBoard);
  const rankList = el("ol", "rank-list");
  const speedRow = el("div", "speed-row");
  speedRow.setAttribute("role", "group");
  speedRow.setAttribute("aria-label", "Vitesse du temps");
  const speedBtns = SPEEDS.map((s) => {
    const b = el("button", undefined, s === 1 ? "Réel" : `×${s}`);
    b.addEventListener("click", () => {
      session.setScale(s);
      write("regate.speed", s);
      refreshSpeed();
    });
    speedRow.append(b);
    return { s, b };
  });
  const refreshSpeed = (): void => {
    for (const { s, b } of speedBtns) b.setAttribute("aria-pressed", String(session.scale === s));
  };
  refreshSpeed();
  const quitBtn = el("button", "ghost wide", "Retour à l'accueil");
  board.append(boardHead, rankList, speedRow, quitBtn, el("p", "attrib", ATTRIBUTION));
  root.append(board);
  app.append(root);

  const view = new MapView(canvas, polar.draftM);
  const compass = new Compass(compassCanvas);
  const field = world.wind;

  // Player controls
  let draft: number | null = null;
  let mode: Order["mode"] = session.activeOrder().mode;
  let follow = true;
  let viewOffset = 0;
  let prediction: ReturnType<typeof predictTrack> | null = null;
  let predictionKey = "";

  const setMode = (m: Order["mode"]): void => {
    mode = m;
    modeHeading.setAttribute("aria-pressed", String(m === "heading"));
    modeTwa.setAttribute("aria-pressed", String(m === "twa"));
    if (draft === null) draft = session.player.heading;
    predictionKey = "";
  };
  modeHeading.addEventListener("click", () => setMode("heading"));
  modeTwa.addEventListener("click", () => setMode("twa"));
  modeHeading.setAttribute("aria-pressed", String(mode === "heading"));
  modeTwa.setAttribute("aria-pressed", String(mode === "twa"));

  const setDraft = (h: number): void => {
    draft = norm360(h);
    predictionKey = "";
  };
  const validate = (): void => {
    if (draft === null || session.player.status === "finished") return;
    const w = sampleWind(field, session.player.x, session.player.y, session.player.t);
    session.sendOrder(mode, mode === "heading" ? draft : norm180(draft - w.twd));
    draft = null;
    predictionKey = "";
  };
  const cancel = (): void => {
    draft = null;
    predictionKey = "";
  };

  const advice = (): HelmAdvice => adviseHelm(world, router, session.player);
  bestBtn.addEventListener("click", () => setDraft(advice().heading));
  cancelBtn.addEventListener("click", cancel);
  validateBtn.addEventListener("click", validate);
  compass.onChange = setDraft;

  menuBtn.addEventListener("click", () => board.classList.remove("hidden"));
  closeBoard.addEventListener("click", () => board.classList.add("hidden"));

  let running = true;
  const leave = (): void => {
    running = false;
    session.save();
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("visibilitychange", onVisibility);
    if (challenge && session.over) leaveChallengeLink();
    else showHome(loaded, challenge);
  };
  quitBtn.addEventListener("click", leave);

  const overview = (): void => {
    follow = false;
    const c = world.course;
    const pose = session.playerPose();
    view.fit([c.startA, c.startB, c.finishA, c.finishB, ...c.gates.map((g) => g.buoy), pose], Math.min(110, view.width * 0.14));
  };
  const onResize = (): void => view.resize();
  window.addEventListener("resize", onResize);
  const onVisibility = (): void => {
    if (document.visibilityState === "hidden") session.save();
  };
  document.addEventListener("visibilitychange", onVisibility);
  recentreBtn.addEventListener("click", () => {
    follow = true;
    view.zoom = 0.09;
  });
  overviewBtn.addEventListener("click", overview);

  const onKey = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const stepDeg = e.shiftKey ? 10 : 1;
    const base = draft ?? session.player.heading;
    if (e.key === "ArrowLeft") setDraft(base - stepDeg);
    else if (e.key === "ArrowRight") setDraft(base + stepDeg);
    else if (e.key === "Enter") validate();
    else if (e.key === "Escape") cancel();
    else return;
    e.preventDefault();
  };
  window.addEventListener("keydown", onKey);

  slider.addEventListener("input", () => {
    viewOffset = (Number(slider.value) / 1000) * Math.max(0, session.closeT - session.simT);
    nowBtn.classList.toggle("hidden", viewOffset === 0);
  });
  nowBtn.addEventListener("click", () => {
    viewOffset = 0;
    slider.value = "0";
    nowBtn.classList.add("hidden");
  });

  // Map gestures: drag near the boat to steer, elsewhere to pan, two fingers or wheel to zoom.
  const pointers = new Map<number, { x: number; y: number }>();
  let steering = false;
  let pinchStart = 0;
  let pinchZoom = 0;
  const localXY = (e: PointerEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const headingFromPointer = (p: { x: number; y: number }): number => {
    const pose = session.playerPose();
    return Math.round(norm360((Math.atan2(p.x - view.sx(pose.x), -(p.y - view.sy(pose.y))) * 180) / Math.PI));
  };
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    const p = localXY(e);
    pointers.set(e.pointerId, p);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      steering = false;
      pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
      pinchZoom = view.zoom;
      return;
    }
    const pose = session.playerPose();
    steering = Math.hypot(p.x - view.sx(pose.x), p.y - view.sy(pose.y)) < 76;
    if (steering) setDraft(headingFromPointer(p));
  });
  canvas.addEventListener("pointermove", (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const p = localXY(e);
    pointers.set(e.pointerId, p);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      view.zoom = pinchZoom * (Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinchStart));
      view.clampView();
    } else if (steering) {
      setDraft(headingFromPointer(p));
    } else {
      follow = false;
      view.centerX -= (p.x - prev.x) / view.zoom;
      view.centerY += (p.y - prev.y) / view.zoom;
      view.clampView();
    }
  });
  const endPointer = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) steering = false;
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      view.zoom *= Math.exp(-e.deltaY * 0.0012);
      view.clampView();
    },
    { passive: false },
  );

  const toast = (text: string): void => {
    const t = el("div", "toast");
    t.textContent = text;
    root.append(t);
    setTimeout(() => t.remove(), 2600);
  };

  const showResults = (): void => {
    const rows = session.finalRanking();
    const myRank = rows.findIndex((r) => r.isPlayer) + 1;
    const me = rows[myRank - 1];
    const overlay = el("div", "overlay");
    const box = el("div", "dialog");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Résultat de la course");
    const heading = el("h2");
    const intro = el("p");
    const rival = rows.find((r) => r.id === RIVAL_ID);
    if (challenge && rival) {
      const won =
        me.finishT !== null
          ? rival.finishT === null || me.finishT <= rival.finishT
          : rival.finishT === null && me.remainingM <= rival.remainingM;
      heading.textContent = won ? "Défi gagné !" : `${rival.name} garde l'avantage`;
      const gap =
        me.finishT !== null && rival.finishT !== null
          ? duration(Math.abs(me.finishT - rival.finishT))
          : me.finishT === null && rival.finishT === null
            ? nm(Math.abs(me.remainingM - rival.remainingM))
            : null;
      const mine = me.finishT !== null ? `Arrivée en ${duration(me.finishT - session.startT)}` : `Il vous restait ${nm(me.remainingM)}`;
      intro.textContent = gap ? `${mine}, avec un écart de ${gap}.` : `${mine}.`;
    } else if (me.finishT !== null) {
      heading.textContent = myRank === 1 ? "Victoire !" : `${myRank}e sur ${rows.length}`;
      intro.textContent = `Arrivée en ${duration(me.finishT - session.startT)} sur ${world.course.def.name}.`;
    } else {
      heading.textContent = "Non classé à la clôture";
      intro.textContent = `Il vous restait ${nm(me.remainingM)} à la clôture de ${hhmm(session.closeT)}.`;
    }
    const list = el("ol", "rank-list");
    fillRanks(list, rows);
    box.append(heading, intro);
    if (session.rivalDrift) {
      box.append(el("p", "note", "Cet appareil recalcule un résultat un peu différent de celui du lien : le temps affiché est celui recalculé ici."));
    }
    box.append(list, shareBlock());
    const done = el("button", "ghost wide", "Retour à l'accueil");
    done.addEventListener("click", leave);
    const stay = el("button", "ghost wide", "Regarder la carte");
    stay.addEventListener("click", () => overlay.remove());
    box.append(done, stay);
    overlay.append(box);
    root.append(overlay);
  };

  const shareBlock = (): HTMLElement => {
    const block = el("div", "share");
    if (!loaded.shared) {
      block.append(el("p", "note", "Pas de lien de défi : cette course n'est pas la course commune publiée."));
      return block;
    }
    if (session.orders.length > MAX_CHALLENGE_ORDERS) {
      block.append(el("p", "note", "Pas de lien de défi : trop d'ordres pour tenir dans un lien."));
      return block;
    }
    const field = el("label", "field", "Votre nom sur le lien");
    const input = el("input");
    input.maxLength = MAX_NAME_LENGTH;
    input.autocomplete = "off";
    input.placeholder = "Un ami";
    input.value = read<string>("regate.name") ?? "";
    field.append(input);
    const send = el("button", "primary wide", challenge ? "Renvoyer un défi" : "Défier un ami");
    const output = el("input", "share-link hidden");
    output.readOnly = true;
    output.setAttribute("aria-label", "Lien du défi");
    const status = el("p", "note hidden");
    status.setAttribute("role", "status");
    send.addEventListener("click", () => {
      write("regate.name", input.value);
      const url = `${location.origin}${location.pathname}#defi=${session.shareCode(input.value)}`;
      output.value = url;
      output.classList.remove("hidden");
      output.select();
      const say = (text: string): void => {
        status.textContent = text;
        status.classList.remove("hidden");
      };
      void (async () => {
        try {
          await navigator.clipboard.writeText(url);
          say("Lien copié. Collez-le à la personne que vous défiez.");
        } catch {
          say("Copiez ce lien et envoyez-le à la personne que vous défiez.");
        }
      })();
    });
    block.append(field, send, output, status);
    return block;
  };

  const fillRanks = (list: HTMLElement, rows: ReturnType<Session["ranking"]>): void => {
    list.replaceChildren();
    const leader = rows[0];
    rows.forEach((r, i) => {
      const li = el("li", r.isPlayer ? "me" : undefined);
      const pos = el("span", undefined, String(i + 1));
      const swatch = el("span", "swatch");
      swatch.style.background = r.color;
      const name = el("span", "rank-name");
      name.textContent = r.name;
      const gap = el("span", "rank-gap");
      if (r.finishT !== null) {
        gap.textContent = i === 0 || leader.finishT === null ? duration(r.finishT - session.startT) : `+${duration(r.finishT - leader.finishT)}`;
      } else {
        gap.textContent = nm(r.remainingM);
      }
      li.append(pos, swatch, name, gap);
      list.append(li);
    });
  };

  const onEvents = (events: RaceEvent[]): void => {
    for (const ev of events) {
      if (ev.kind === "mark") toast(`Bouée ${ev.name} validée !`);
      else if (ev.kind === "grounded") toast(ev.byTide ? "La mer s'est retirée sous le bateau" : "Échoué sur le sable !");
      else if (ev.kind === "afloat") toast("Le bateau repart");
      else if (ev.kind === "finished" || ev.kind === "closed") showResults();
    }
  };

  // HUD refresh runs a few times per second: text does not need 60 fps.
  let lastHud = 0;
  const refreshHud = (viewT: number, tideM: number): void => {
    const s = session.player;
    const w = sampleWind(field, s.x, s.y, s.t);
    const shownWind = viewOffset > 0 ? sampleWind(field, s.x, s.y, viewT) : w;
    cSpeed.b.textContent = `${s.speedKn.toFixed(1)} nd`;
    cSpeed.sub.textContent = `${Math.round(s.heading)}° ${mode === "twa" ? "· angle" : "· cap"}`;
    cWind.b.innerHTML = `<span class="wind-arrow" style="transform:rotate(${(shownWind.twd + 180).toFixed(0)}deg)">↑</span> ${shownWind.tws.toFixed(0)} nd`;
    cWind.sub.textContent = `de ${windName(shownWind.twd)} (${Math.round(shownWind.twd)}°)`;
    const next = nextTideExtremum(world.tide, viewT);
    const rising = tideAt(world.tide, viewT + 300) >= tideM;
    cTide.b.textContent = `${(tideM + MSL_ABOVE_DATUM_M).toFixed(1)} m ${rising ? "↗" : "↘"}`;
    cTide.sub.textContent = next ? `${next.kind === "high" ? "PM" : "BM"} ${hhmm(next.t)}` : "";
    const gate = world.course.gates[s.nextMark];
    const target = nextTarget(world.course, s.nextMark);
    cMark.b.textContent = gate ? gate.name : "Arrivée";
    cMark.sub.textContent = `${nm(dist(s, target))}${gate ? ` · à ${sideName(gate.side)}` : ""}`;
    const rows = session.ranking();
    const rank = rows.findIndex((r) => r.isPlayer) + 1;
    cRank.b.textContent = `${rank}e/${rows.length}`;
    cRank.sub.textContent = hhmm(session.simT);
    if (!board.classList.contains("hidden")) fillRanks(rankList, rows);

    when.textContent = viewOffset > 0 ? hhmm(viewT) : "en direct";

    if (s.status === "grounded") {
      const freeNow = s.groundedByTide;
      banner.textContent = freeNow
        ? "Échoué : la mer s'est retirée. Il faut attendre que l'eau remonte."
        : "Échoué : choisissez un cap qui vous éloigne du sable, puis validez.";
      banner.className = "banner";
    } else if (s.status === "sailing" && Math.abs(norm180(s.heading - w.twd)) <= 40) {
      banner.textContent = "Trop près du vent : le bateau n'avance plus. Abattez !";
      banner.className = "banner warn";
    } else if (viewOffset > 0) {
      banner.textContent = `Aperçu de ${hhmm(viewT)} : les bateaux restent à l'heure actuelle.`;
      banner.className = "banner warn";
    } else {
      banner.className = "banner hidden";
    }

    validateBtn.disabled = draft === null || s.status === "finished";
    cancelBtn.disabled = draft === null;
  };

  const refreshGauge = (headingShown: number): void => {
    const s = session.player;
    const w = sampleWind(field, s.x, s.y, s.t);
    const best = advice();
    const v =
      boatSpeed(polar, Math.abs(norm180(headingShown - w.twd)), w.tws) *
      Math.cos(((headingShown - best.routeBearing) * Math.PI) / 180);
    const ratio = best.vmgKn > 0 ? Math.max(0, Math.min(1, v / best.vmgKn)) : 0;
    gaugePin.style.left = `${(ratio * 100).toFixed(0)}%`;
    gaugeLabel.textContent = ratio > 0.92 ? "Vers la bouée : excellent" : ratio > 0.7 ? "Vers la bouée : correct" : "Vers la bouée : à revoir";
  };

  let tutorialOpen = false;
  let last = performance.now();
  const frame = (nowMs: number): void => {
    if (!running) return;
    const dt = Math.min(0.1, (nowMs - last) / 1000);
    last = nowMs;
    if (tutorialOpen) session.hold();
    else onEvents(session.advance());
    const pose = session.playerPose();
    const s = session.player;
    const viewT = viewOffset > 0 ? session.simT + viewOffset : session.simT;
    const tideM = tideAt(world.tide, viewT);
    const liveWind = sampleWind(field, s.x, s.y, s.t);

    if (follow) {
      view.centerX = pose.x;
      view.centerY = pose.y;
      view.clampView();
    }

    const order: Omit<Order, "t"> | null =
      draft !== null
        ? { mode, value: mode === "heading" ? draft : norm180(draft - liveWind.twd) }
        : s.status === "finished"
          ? null
          : { mode: session.activeOrder().mode, value: session.activeOrder().value };
    if (order) {
      const key = `${order.mode}:${order.value}:${s.t}`;
      if (key !== predictionKey) {
        predictionKey = key;
        prediction = predictTrack(world, s, order, 900);
      }
    } else {
      prediction = null;
    }

    const others = session.bots.map((b) => {
      const p = session.botPose(b);
      return {
        x: p.x,
        y: p.y,
        heading: p.heading,
        twd: sampleWind(field, p.x, p.y, session.simT).twd,
        color: b.profile.color,
        label: b.profile.id === RIVAL_ID ? b.profile.name : b.profile.name.split(" ")[0],
        size: b.profile.id === RIVAL_ID ? 11 : 9,
        speedKn: p.speedKn,
      };
    });
    view.draw(
      {
        course: world.course,
        nextMark: s.nextMark,
        player: {
          x: pose.x,
          y: pose.y,
          heading: pose.heading,
          twd: liveWind.twd,
          color: PLAYER_COLOR,
          size: 12,
          speedKn: s.speedKn,
        },
        others,
        trail: session.trail,
        prediction,
        draftHeading: draft,
        windAt: (x, y) => sampleWind(field, x, y, viewT),
        tideM,
      },
      dt,
    );

    const shownHeading = draft ?? s.heading;
    const wantedOrderHeading = order ? headingFor({ ...order, t: 0 }, liveWind.twd) : s.heading;
    const vmg = bestVmgAngles(polar, liveWind.tws);
    compass.draw({
      heading: s.heading,
      draft,
      twd: liveWind.twd,
      tws: liveWind.tws,
      target: bearing(s, nextTarget(world.course, s.nextMark)),
      upwind: vmg.upwind,
      downwind: vmg.downwind,
      speedKn: boatSpeed(polar, Math.abs(norm180(wantedOrderHeading - liveWind.twd)), liveWind.tws),
    });

    if (nowMs - lastHud > 200) {
      lastHud = nowMs;
      refreshHud(viewT, tideM);
      refreshGauge(shownHeading);
    }
    requestAnimationFrame(frame);
  };

  // Debug and test access: read-only use from the browser console.
  (window as unknown as { __regate: unknown }).__regate = { session, view };

  view.zoom = 0.09;
  const firstPos = startPosition(world.course, 0.5);
  view.centerX = firstPos.x;
  view.centerY = firstPos.y;
  tutorialOpen = !read<boolean>("regate.tutorial");
  if (tutorialOpen) {
    showTutorial(root, () => {
      tutorialOpen = false;
      write("regate.tutorial", true);
    });
  }
  requestAnimationFrame(frame);
}

function showTutorial(root: HTMLElement, onDone: () => void): void {
  let i = 0;
  const overlay = el("div", "overlay");
  const box = el("div", "dialog");
  box.setAttribute("role", "dialog");
  const render = (): void => {
    box.replaceChildren();
    const [title, text] = TUTORIAL[i];
    const h = el("h2");
    h.textContent = title;
    const p = el("p");
    p.textContent = text;
    const steps = el("div", "steps", `${i + 1} / ${TUTORIAL.length}`);
    const next = el("button", "primary wide", i === TUTORIAL.length - 1 ? "C'est parti !" : "Suivant");
    next.addEventListener("click", () => {
      i++;
      if (i >= TUTORIAL.length) {
        overlay.remove();
        onDone();
      } else {
        render();
      }
    });
    box.append(steps, h, p, next);
  };
  render();
  overlay.append(box);
  root.append(overlay);
}

/** Removes a challenge from the address, and shows the race of the day. */
function leaveChallengeLink(): void {
  history.replaceState(null, "", location.pathname + location.search);
  void boot();
}

function showChallengeError(text: string): void {
  app.replaceChildren();
  const home = el("div", "home");
  const inner = el("div", "home-inner");
  const card = el("section", "card", "<h2>Défi indisponible</h2>");
  const message = el("p", "desc");
  message.textContent = text;
  const back = el("button", "primary wide", "Voir la course du jour");
  back.addEventListener("click", leaveChallengeLink);
  card.append(message, back);
  inner.append(card);
  home.append(inner);
  app.append(home);
}

async function boot(): Promise<void> {
  app.replaceChildren(
    el("div", "home", `<div class="home-inner"><header class="brand"><h1>Régate du Bassin</h1><p>Récupération du vent et de la marée…</p></header></div>`),
  );
  if (location.hash.startsWith("#defi=")) {
    const code = location.hash.slice("#defi=".length);
    const data = decodeChallenge(code);
    if (!data) {
      showChallengeError("Ce lien de défi est incomplet ou incorrect. Demandez à votre ami de le renvoyer.");
      return;
    }
    purgeOldDays([parisDate(), data.date]);
    const daily = await loadDaily(data.date);
    if (!daily || !courses.some((c) => c.id === data.courseId)) {
      showChallengeError("La course de ce défi n'a pas pu être chargée. Vérifiez la connexion, puis rouvrez le lien.");
      return;
    }
    showHome({ snapshot: daily.snapshot, shared: true, live: true, courseId: data.courseId }, { code, data });
    return;
  }
  purgeOldDays([parisDate()]);
  showHome(await loadSnapshot());
}

// A link pasted into a tab already open only changes the address after the #.
window.addEventListener("hashchange", () => void boot());

void boot();
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("./sw.js").catch(() => undefined);
}
