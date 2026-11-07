# Régate du Bassin

Régate virtuelle sur le Bassin d'Arcachon, avec le vent et la marée réels du jour. On donne un cap, le bateau avance, et à marée basse les bancs de sable découvrent : il faut passer par les chenaux.

**Prototype : vous courez contre 5 bots, et vous pouvez défier un ami avec un lien.** Le multijoueur avec comptes et classement partagé (jalon M4) n'est pas encore fait.

## Ce qui fonctionne

- Simulation pure et déterministe, partagée et testée (`packages/sim`) : polaires, vent interpolé sur u/v, virements, échouage, bouées avec côté de passage.
- Course du jour commune : une tâche GitHub Actions publie chaque matin le même vent, la même marée et le même parcours pour tout le monde.
- Défi par lien : le lien contient vos ordres. Votre bateau navigue à côté de celui de votre ami, sans serveur ni compte.
- Secours : avant la publication du matin, le navigateur récupère sa propre météo (sans lien de défi possible). Sans réseau, il utilise une course enregistrée.
- Vrais fonds du Bassin : les bancs découvrent selon la marée, et les chenaux restent ouverts.
- 6 parcours, choix automatique selon le vent et la marée, 5 bots qui passent par les chenaux.
- Compas tactile et clavier, trajectoire prévue sur 15 min, jauge de cap, curseur de prévisions, classement, historique local, tutoriel, PWA.
- Le bateau continue d'avancer quand l'appli est fermée.

## Ce qui reste à faire

- **M4 multijoueur** : Supabase, comptes, ordres et simulation côté serveur.
- **M5** : éditeur caché `?editor=1`, et test de performance sur un vrai téléphone.
- La position des bouées reste à valider ensemble, et la marée à vérifier en vive-eau et en morte-eau ([rapport](docs/tide-report.md)).

## Démarrer

Il faut Node 22.18 ou plus récent.

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run build
```

Aucune variable d'environnement n'est nécessaire pour l'instant.

Options d'URL et touches :

- `?course=arguin` force un parcours (l'identifiant vient de `data/courses.json`).
- `#defi=…` ouvre un défi reçu par lien.
- Flèches : ±1°, Maj + flèches : ±10°, Entrée : valider, Échap : annuler.

## Organisation

```
apps/web         front : Vite, TypeScript, Canvas 2D, sans framework
packages/sim     simulation pure, partagée et testée
data             côte, fonds, parcours, bateaux, course enregistrée
scripts          préparation de la carte, course du jour, contrôle de la marée et des navigateurs
docs             rapport sur la marée
```

## Course du jour et défis

La branche `course-du-jour` contient un fichier par jour (`AAAA-MM-JJ.json`). `.github/workflows/ci.yml` l'alimente à 3 h 10 et 5 h 40 UTC, puis publie ces fichiers avec le site sous `daily/`. Un jour publié n'est jamais réécrit, car les liens de défi le rejouent ensuite.

Pour tester en local, publiez la course du jour dans le dossier du front (ignoré par git) :

```bash
node scripts/publish-daily.ts apps/web/public/daily
```

GitHub suspend les tâches planifiées d'un dépôt public après 60 jours sans activité : il faut alors les réactiver dans l'onglet Actions.

Un lien de défi n'est pas une preuve : quelqu'un peut en fabriquer un à la main. C'est suffisant entre amis, pas pour un classement officiel.

## Ajouter un parcours

Ajoutez une entrée dans `data/courses.json` : ligne de départ, bouées (position, nom, côté `port` pour bâbord ou `starboard` pour tribord) et ligne d'arrivée. `npm test` fait courir un bot sur chaque parcours, avec le vent réel enregistré et quatre directions de vent, et échoue si l'arrivée n'est pas atteinte.

## Ajouter un bateau

Ajoutez un fichier dans `data/boats/` au format de `catamaran.json` : tirant d'eau et polaire. Le choix du bateau en jeu reste à brancher.

## Refaire les données

```bash
pip install numpy scipy shapely pillow
```

```bash
python scripts/build_map.py
```

```bash
npm run snapshot -- 2026-11-07
```

## Déploiement

Chaque push sur `main` lance les tests et publie sur GitHub Pages (`.github/workflows/ci.yml`).

## Écarts avec le brief

- **Bancs** : le brief prévoyait des polygones dessinés à la main. Le jeu utilise la bathymétrie ouverte EMODnet, bien plus fidèle, sous forme de grille. `data/banks.geojson` n'existe donc pas.
- **Déterminisme** : les fonctions `Math.sin`, `cos`, `atan2` et `hypot` varient selon les navigateurs, et ces écarts infimes changeaient parfois l'issue d'une course. La simulation utilise donc ses propres versions (`packages/sim/src/dmath.ts`). `scripts/engine-check/run.mjs` compare Chromium, Firefox et WebKit à chaque push. Le serveur restera la seule référence officielle.
- **Marée** : Open-Meteo recalé sur Eyrac suffit pour l'instant, le plan B harmonique n'a pas été nécessaire.
- **Gestionnaire de paquets** : npm, déjà installé, à la place de pnpm.

## Sources et licences

Carte simplifiée, **ne pas utiliser pour la navigation**.

- Trait de côte © contributeurs [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL).
- Fonds marins [EMODnet Bathymetry](https://emodnet.ec.europa.eu/en/bathymetry) (CC BY 4.0).
- Vent et marée [Open-Meteo](https://open-meteo.com/), modèles Météo-France (CC BY 4.0), gratuit pour un usage non commercial.
