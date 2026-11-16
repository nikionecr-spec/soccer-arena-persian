# Goal sensor — emits goal_entered when the ball crosses the line
extends Node3D

signal goal_entered

@onready var area: Area3D = $Area

func _ready() -> void:
	area.body_entered.connect(_on_body)

func _on_body(body: Node3D) -> void:
	if body.name == "Ball":
		goal_entered.emit()
