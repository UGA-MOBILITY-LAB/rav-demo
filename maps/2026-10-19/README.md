# Maps 2026-10-19

Autoware lanelet2 + point-cloud maps as used on the UGA Mach-E on 2026-10-19. Added in a new folder;
no existing file is changed.

## hawkins/ (MGRS 17SKR)
- Right-turn merges that stop at the stop line, creep and yield to traffic from the left: hospital
  exit (44860 split, main-road upstream lane 48950), 15701 (upstream 48908), 29582 (split, upstream
  49035), 29644 (upstream 48993).
- Stop lines 44867 and 46937 redrawn straight across the lane.
- Earlier edits: stop signs 46976/46983 removed; speed limits 60 / 45 / 35 km/h on the big roads.

## e23/ (MGRS 17SKT)
- Traffic light and stop sign removed (none on site); speed_limit 40.

## sha256
- `e23/lanelet2_map.osm` 3b9f3320a2f3d3d6422e5ea2c92469c3dd4ef8aeac151cb85d4299d4a1d9319f
- `e23/map_projector_info.yaml` c23da65db97b665331f72cf076b568961996b227d699d8b3acda27ae9342b7e4
- `e23/pointcloud_map.pcd` 69514b8089885474c4fb49ef3a846d1414ce321efb178a3af934696406a67979
- `hawkins/lanelet2_map.osm` 6a0f248aaea133366891a04ed7c73a2b14fea1c04b8aa516c5159f9f0d5c2d7b
- `hawkins/map_projector_info.yaml` f5bb4fdde4f8919eaf175a61c14b5e25feb2f011b7a1fa07620713bd28dd119d
- `hawkins/pointcloud_map.pcd` 3edeb44ecc95fa397f65fbd7d7f0d0455ee9b16676a47879c96176c2989808e8
