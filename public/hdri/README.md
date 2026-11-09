# HDRI skies

`kloofendal_48d_partly_cloudy_2k.hdr`: "Kloofendal 48d Partly Cloudy" from
[Poly Haven](https://polyhaven.com/a/kloofendal_48d_partly_cloudy), CC0. The default: with its
ground, the reflections in glass and metal have dark and bright parts, as in the Babylon sandbox.

`kloofendal_48d_partly_cloudy_puresky_2k.hdr`: the "Pure Sky" version of the same image
([Poly Haven](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky), CC0), ground removed.

Changed from the originals: the brightest pixels (the sun disc, 58 and 59 of them) are capped at
200 with `npm run hdr:cap -- <file>`. The original peak of about 73,000 overflows the half-float
render targets and shows as a black square. The scene's directional light supplies the sun, so
nothing is lost.
