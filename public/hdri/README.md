# HDRI skies

`kloofendal_48d_partly_cloudy_puresky_2k.hdr`: "Kloofendal 48d Partly Cloudy (Pure Sky)" from
[Poly Haven](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky), CC0.

Changed from the original: the 59 brightest pixels (the sun disc) are capped at 200. The original
peak of about 72,000 overflows the half-float render targets and shows as a black square. The
scene's directional light supplies the sun, so nothing is lost.
