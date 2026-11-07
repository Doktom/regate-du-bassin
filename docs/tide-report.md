# Rapport marée (test du jalon M3)

**Conclusion : on garde Open-Meteo Marine, recalé sur Eyrac. Le plan B harmonique n'est pas nécessaire pour l'instant.**

## Méthode

Comparaison de `sea_level_height_msl` (Open-Meteo Marine) avec l'annuaire d'Arcachon, jetée d'Eyrac ([maree.info/136](https://maree.info/136), relevé le 7 novembre 2026), sur les 27 pleines et basses mers du 7 au 13 novembre 2026. Les extrêmes du modèle sont retrouvés par ajustement parabolique sur les valeurs horaires. Pour refaire le calcul : `python scripts/tide_check.py`, après avoir recopié l'annuaire dans le fichier local indiqué dans le script (il n'est pas redistribué ici).

## Résultats

La maille du modèle (44,625 N, 1,29 W) est en mer, à l'extérieur du Bassin. Les valeurs sont identiques à celles de la maille voisine : aucune variation à l'intérieur du Bassin n'est résolue.

| Mesure | Résultat |
|---|---|
| Retard d'Eyrac sur le modèle | 89 min en moyenne (écart type 7 min, de 79 à 100 min) |
| Retard à pleine mer / à basse mer | 85 min / 93 min |
| Ajustement des hauteurs | `h_eyrac = 1,065 × h_modèle + 2,707` (au-dessus du zéro des cartes) |
| Écart sur les hauteurs après recalage | 0,10 m d'écart type, 0,24 m au maximum |

## Décision

Le jeu applique ce recalage (`TIDE_CALIBRATION` dans `packages/sim/src/tide.ts`) : +89 min, ×1,065, +0,257 m par rapport au niveau moyen (pris à 2,45 m au-dessus du zéro des cartes).

Contrôle sur le jeu du 7 novembre : basse mer à 09h45 et 0,7 m (annuaire : 09h51 et 0,76 m), pleine mer à 16h20 et 4,1 m (annuaire : 16h10 et 4,18 m).

## Limites

- Le test couvre une semaine de coefficients moyens (63 à 84). Il reste à vérifier sur une vive-eau et une morte-eau : la déformation de la marée dans le Bassin varie avec le coefficient, et un seul recalage pourrait ne plus suffire.
- Le retard moyen cache 8 minutes de différence entre pleine et basse mer. C'est acceptable pour un jeu.
- Une seule hauteur vaut pour tout le Bassin, comme prévu dans le brief pour la V1.
