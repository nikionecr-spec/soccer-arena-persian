# Main arena controller — score, goals, taps, quality toggle
extends Node3D

const FA_DIGITS := ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"]

var score := [0, 0]
var _resetting := false

@onready var hud: CanvasLayer = $HUD
@onready var ball: RigidBody3D = $Ball
@onready var flashes: GPUParticles3D = $CrowdFlashes
@onready var cam_rig: Node3D = $CameraRig

func _ready() -> void:
	$GoalA.goal_entered.connect(_on_goal.bind(0))
	$GoalB.goal_entered.connect(_on_goal.bind(1))
	cam_rig.tapped.connect(_on_tap)
	hud.quality_toggled.connect(_on_quality)
	hud.set_score(fa_num(score[0]) + "  —  " + fa_num(score[1]))
	hud.flash_message("برای چرخش بکشید • برای شوت روی توپ بزنید")

func fa_num(n: int) -> String:
	var s := str(n)
	for i in range(10):
		s = s.replace(str(i), FA_DIGITS[i])
	return s

func _on_goal(team: int) -> void:
	if _resetting:
		return
	_resetting = true
	score[team] += 1
	hud.set_score(fa_num(score[0]) + "  —  " + fa_num(score[1]))
	hud.flash_message("گـــل!  " + ("تیم آبی" if team == 0 else "تیم نارنجی"))
	flashes.restart()
	ball.freeze = true
	await get_tree().create_timer(1.4).timeout
	ball.linear_velocity = Vector3.ZERO
	ball.angular_velocity = Vector3.ZERO
	ball.global_position = Vector3(0, 2.4, 0)
	ball.freeze = false
	_resetting = false

func _on_tap(screen_pos: Vector2) -> void:
	var cam: Camera3D = cam_rig.get_node("Camera3D")
	var from := cam.project_ray_origin(screen_pos)
	var dir := cam.project_ray_normal(screen_pos)
	var q := PhysicsRayQueryParameters3D.create(from, from + dir * 150.0)
	q.collide_with_bodies = true
	var hit := get_world_3d().direct_space_state.intersect_ray(q)
	if hit and hit.collider == ball:
		var flat := Vector3(dir.x, 0.0, dir.z).normalized()
		ball.apply_central_impulse(flat * 16.0 + Vector3.UP * 7.0)

func _on_quality() -> void:
	var e: Environment = $WorldEnvironment.environment
	e.glow_enabled = not e.glow_enabled
	hud.flash_message("کیفیت گرافیکی: " + ("کامل (درخشش فعال)" if e.glow_enabled else "سبک"))
