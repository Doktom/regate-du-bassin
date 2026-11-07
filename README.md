# Régate du Bassin

Régate virtuelle sur le Bassin d'Arcachon, avec le vent et la marée réels du jour. On donne un cap, le bateau avance, et à marée basse les bancs de sable découvrent : il faut passer par les chenaux.

**Prototype solo : vous courez contre 5 bots.** Le multijoueur entre amis (jalon M4) n'est pas encore fait.

## Ce qui fonctionne

- Simulation pure et déterministe, partagée et testée (`packages/sim`) : polaires, vent interpolé sur u/v, virements, échouage, bouées avec côté de passage.
- Course du jour automatique : vent AROME et marée récupérés dans le navigateur puis figés pour la journée, avec une course enregistrée en secours hors ligne.
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
- Flèches : ±1°, Maj + flèches : ±10°, Entrée : valider, Échap : annuler.

## Organisation

```
apps/web         front : Vite, TypeScript, Canvas 2D, sans framework
packages/sim     simulation pure, partagée et testée
data             côte, fonds, parcours, bateaux, course enregistrée
scripts          préparation de la carte, récupération météo, contrôle de la marée
docs             rapport sur la marée
```

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
- **Déterminisme** : garanti au bit près dans un même moteur JavaScript. Le serveur devra rester la seule référence officielle.
- **Marée** : Open-Meteo recalé sur Eyrac suffit pour l'instant, le plan B harmonique n'a pas été nécessaire.
- **Gestionnaire de paquets** : npm, déjà installé, à la place de pnpm.

## Sources et licences

Carte simplifiée, **ne pas utiliser pour la navigation**.

- Trait de côte © contributeurs [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL).
- Fonds marins [EMODnet Bathymetry](https://emodnet.ec.europa.eu/en/bathymetry) (CC BY 4.0).
- Vent et marée [Open-Meteo](https://open-meteo.com/), modèles Météo-France (CC BY 4.0), gratuit pour un usage non commercial.
