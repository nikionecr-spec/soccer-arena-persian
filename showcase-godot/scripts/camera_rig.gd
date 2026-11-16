# Cinematic orbit camera: drag to rotate, pinch to zoom, tap emits a signal
extends Node3D

signal tapped(at_position: Vector2)

@onready var cam: Camera3D = $Camera3D

var yaw := 0.7
var pitch := 0.52
var dist := 36.0

var _dragging := false
var _moved := 0.0

func _ready() -> void:
	_apply()

func _apply() -> void:
	rotation = Vector3(0.0, yaw, 0.0)
	var h := dist * sin(pitch)
	var r := dist * cos(pitch)
	cam.position = Vector3(0.0, h, r)
	cam.look_at_from_position(cam.global_position, Vector3(0.0, 1.2, 0.0), Vector3.UP)

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventScreenTouch:
		if event.pressed:
			_dragging = true
			_moved = 0.0
		else:
			_dragging = false
			if _moved < 14.0:
				tapped.emit(event.position)
	elif event is InputEventScreenDrag and _dragging:
		yaw -= event.relative.x * 0.005
		pitch = clampf(pitch + event.relative.y * 0.004, 0.22, 1.25)
		_moved += event.relative.length()
		_apply()
	elif event is InputEventMagnifyGesture:
		dist = clampf(dist / event.factor, 16.0, 60.0)
		_apply()
