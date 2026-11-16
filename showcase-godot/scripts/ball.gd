# Ball — clamps runaway velocities, keeps physics stable on mobile
extends RigidBody3D

const MAX_SPEED := 26.0

func _physics_process(_dt: float) -> void:
	if linear_velocity.length() > MAX_SPEED:
		linear_velocity = linear_velocity.normalized() * MAX_SPEED
