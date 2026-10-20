---
title: Ename
language: fr
plausible: pa-NWFuzA3_hWw7CS_EfwUxR
---

# Ename

_Registre public d'identités humaines vérifiées, tenu par une organisation à but non lucratif : la couche d'identité commune sous les plateformes, celle qui permet de changer de plateforme sans rien perdre._

En ligne, un nom n'appartient pas vraiment à la personne qui le porte : il réside dans la base de données d'une entreprise privée, libre de le suspendre, de le réattribuer ou de disparaître avec lui. Il ne prouve pas non plus qui a écrit un message ou pris une photo, une lacune devenue critique maintenant que des machines produisent textes et images comme des humains. Le monde physique a comblé ces deux manques de longue date, avec l'état civil et la signature ; le numérique n'a construit ni l'un ni l'autre. Ename comble cet écart en sortant l'identité de chaque plateforme pour la placer en dessous, commune à toutes.

## L'ename

Un ename est un identifiant lisible, qui se dicte à voix haute, par exemple `jean-dupont#1`. Derrière lui se trouve une personne dont l'identité a été vérifiée. À l'intérieur, une clé cryptographique permet à cette personne de signer ce qu'elle produit, reliant un contenu à son auteur.

Une vie tient rarement dans un seul nom. Quand le nom légal change, après un mariage ou une adoption, la personne reçoit un nouvel ename, et l'ancien n'est pas recyclé : il continue de la désigner. Elle peut aussi faire vivre plusieurs noms à la fois : un créateur affiche `mr-beast#1` en public, adossé au `jimmy-donaldson#1` vérifié qui en répond, et ce nom reste pleinement authentique parce qu'il tient à cette racine.

Un ename ne désigne pas qu'un individu. Les organisations que les humains forment (une société, une association, un organisme) en reçoivent un sur le même principe, `durand-sas#1`, avec une identité vérifiée comme celle d'une personne. Elles aussi changent de nom au fil du temps, et adossent leurs marques ou leurs produits à leur racine comme autant d'enames. Agir au nom de l'une d'elles s'écrit `jean-dupont#1@durand-sas#1`, à la manière d'une adresse e-mail, l'organisation attestant le lien.

La vérification est le cas central, mais il existe aussi des enames non-vérifiés. Sur un forum, dans un jeu, sur un réseau social, on ne souhaite pas toujours dire qui l'on est ; pour un défenseur des droits ou un dissident, le taire peut être nécessaire. Ces enames sont purement déclaratifs : aucune identité établie ne se tient derrière eux. Un point les précède, `.pixel-cat#12`, pour qu'ils se distinguent clairement des enames vérifiés.

## Le registre

Le registre contient très peu de chose : pour chaque ename, une clé publique et le nom de la plateforme dont il relève. Rien d'autre : ni les données, ni les messages, ni les relations, et surtout pas les clés privées, qui restent entre les mains de leur titulaire. Ce qu'un registre ne détient pas, il ne peut ni le perdre, ni le vendre, ni être contraint de le livrer.

## Les plateformes

Les plateformes, non le registre, sont la porte d'entrée : ce sont elles qui délivrent les enames et rendent les services du quotidien. Cette position semble leur donner un pouvoir ; en pratique, presque aucun. Ce qu'une personne produit, elle le signe elle-même, jamais la plateforme à sa place. Chaque signature se vérifie contre les clés publiées par Ename, quelle que soit la plateforme qui l'a transportée. Au pire, une plateforme peut rendre quelqu'un invisible ; elle ne peut pas parler en son nom. Elle ne peut pas non plus retenir ses utilisateurs : qui la quitte emporte son identité et ses données, dans des formats que toute plateforme sait lire, parce que l'architecture l'impose et non par faveur commerciale.

## Les standards

Des plateformes indépendantes ne forment un ensemble cohérent que si elles se comprennent. C'est le rôle des standards d'Ename : des formats communs que toute plateforme accréditée sait lire et écrire. Ils rendent possibles deux choses que les plateformes fermées interdisent. L'interopérabilité d'abord : on écrit à quelqu'un, ou on lit ce qu'il publie, même s'il est sur une autre plateforme. La portabilité ensuite : le jour où l'on s'en va, l'identité et les données se retrouvent intactes chez un concurrent, l'une rendue par le registre, l'autre par la plateforme. Sans ces formats partagés, les deux ne seraient que des promesses.

Une plateforme peut aussi inventer ses propres formats, là où aucun standard n'existe encore : c'est ainsi qu'apparaissent les nouveaux usages. Le risque ne surgit que si l'un de ces formats s'impose largement en restant lisible par elle seule, car ce qu'on y crée se retrouve alors enfermé. Ename y répond par une règle : dès qu'un format propriétaire se répand et touche à des données qu'on ne peut se permettre de perdre, il doit devenir un standard ouvert, soumis à Ename et adoptable par tous. Le succès d'une bonne idée enrichit alors le bien commun au lieu de le verrouiller.

## La gouvernance

Reste à savoir ce qui empêche le registre lui-même de devenir le maître. Il est tenu par Ename, une organisation à but non lucratif. Elle est gouvernée par plusieurs groupes (les plateformes, la société civile, des experts techniques, les membres fondateurs), dont aucun ne détient à lui seul la majorité ; le poids des fondateurs, lui, est appelé à décroître. Son financement écarte les leviers d'abus habituels : ni publicité, ni revente de données, ni mécène unique, ni État, mais les plateformes qu'elle accrédite, ce qui aligne son intérêt sur la durée, non sur ce qu'elle pourrait soutirer à court terme. Enfin, toute règle touchant au format des enames, à l'accréditation des plateformes ou aux droits des personnes passe par une consultation publique.

## L'horizon

L'horizon se mesure en siècles. Un ename créé aujourd'hui doit rester valide et vérifiable longtemps après la mort de celui qui le porte ; quand une plateforme disparaît, les enames, eux, demeurent. L'ambition n'est pas un service de plus pour quelques millions d'initiés, mais une identité ouverte à tout humain qui en veut une.

---

_Nous écrire : [contact@ename.ngo](mailto:contact@ename.ngo)_
